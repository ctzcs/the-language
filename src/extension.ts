/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable curly */


import {Selection, Range, DocumentFilter, CompletionItem, Location, Position, ProviderResult, FoldingRangeKind, IndentAction, commands, SnippetString, SymbolInformation, DocumentSymbol, SymbolKind} from 'vscode';
import {ExtensionContext, languages, workspace, window, extensions, CompletionItemKind} from 'vscode';
import {Uri, TextEditorDecorationType} from 'vscode';
import {TextEditor, DecorationOptions, CompletionItemProvider, TextDocument, CancellationToken} from 'vscode';
import {CompletionContext, FoldingRangeProvider, FoldingRange} from 'vscode';
import {DefinitionProvider, env} from 'vscode';
import {Terminal} from 'vscode';

import path = require('path');
import fs = require('fs');
import os = require('os');

import { supportedLanguages } from "./languages";
import { JaiLanguageService } from './service';

const SELECTOR: DocumentFilter = { language: 'jai', scheme: 'file' };

let editTimeout: NodeJS.Timer | undefined = undefined;
let selections: Array<Selection> = [];
let decorationRanges: Range [] = [];
let selectionsIntersectDecoration = false;
let asmRanges: Range [] = [];
let asmCompletions: CompletionItem [] = [];
let asmURLs: { [id: string] : string; } = {};
let foldingRanges: FoldingRange [] = [];
let documentSymbols: DocumentSymbol[] = [];

let runningSnippet = false;
let languageService: JaiLanguageService;

export function activate(context: ExtensionContext) {
	updateConfig();
	languageService = new JaiLanguageService(context);
	context.subscriptions.push(commands.registerCommand('the-language.refreshIndex', () => {
		const document = window.activeTextEditor?.document;
		if (document) { return languageService.refresh(document); }
	}));


	context.subscriptions.push(languages.registerReferenceProvider(SELECTOR, languageService));
	context.subscriptions.push(languages.registerDefinitionProvider(SELECTOR, new JaiDefinitionProvider()));
	context.subscriptions.push(languages.registerRenameProvider(SELECTOR, languageService));
	context.subscriptions.push(languages.registerCompletionItemProvider(SELECTOR, new JaiCompletionItemProvider()));
	context.subscriptions.push(languages.registerCompletionItemProvider(SELECTOR, languageService, '.', '"', '/', '\\', '#'));
	context.subscriptions.push(languages.registerTypeDefinitionProvider(SELECTOR, languageService));
	context.subscriptions.push(languages.registerHoverProvider(SELECTOR, languageService));
	context.subscriptions.push(languages.registerSignatureHelpProvider(SELECTOR, languageService, '(', ','));
	context.subscriptions.push(languages.registerWorkspaceSymbolProvider(languageService));
	context.subscriptions.push(languages.registerFoldingRangeProvider(SELECTOR, new JaiFoldingRangeProvider()));
	context.subscriptions.push(languages.registerDocumentSymbolProvider(SELECTOR, languageService));

	if (activeEditor) {
		triggerUpdateDecorations();
	}

	context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
		updateConfig();
	}));

	window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		if (editor) {
			updateSelectionAndDecorations();
		}
	}, null, context.subscriptions);

	workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	window.onDidChangeTextEditorSelection(event => {
		if (activeEditor === event.textEditor) {
			selections = [];
			for(let i = 0; i < event.selections.length; i++)
				selections.push(event.selections[i]);
			selections.sort((r1,r2) => {
				if (r1.start.line > r2.start.line)
					return +1;
				else if (r1.start.line < r2.start.line)
					return -1;

				if (r1.start.character > r2.start.character)
					return +1;
				else if (r1.start.character < r2.start.character)
					return -1;

				return 0;
			});
			if (selectionsIntersectDecoration || areIntersecting(selections, decorationRanges)) {
				updateDecorations();
			}
		}
	});

	{
		const command = "the-language.runSnippet";
		const commandHandler = () => {
			if (runningSnippet) return;
			runningSnippet = true;

			let editor = window.activeTextEditor;
			if (!editor) { runningSnippet = false; return; }
			let text = editor.document.getText();
			let selection = editor.selection;
			let snippet : string;
			if (selection.isEmpty) {
				let start = editor.document.offsetAt(selection.active);
				let end = start;
				start = text.lastIndexOf("```", start);
				if (start < 0) { runningSnippet = false; return; }
				start = text.indexOf("\n", start);
				if (start < 0) { runningSnippet = false; return; }
				start += 1;

				end = text.indexOf("```", end);
				if (end < 0) { runningSnippet = false; return; }

				snippet = text.slice(start, end);
			}
			else {
				let start = editor.document.offsetAt(selection.start);
				let end = editor.document.offsetAt(selection.end);
				snippet = text.slice(start, end);
			}
			let prefix = "";
			let postfix = "";
			if (runSnippetHeader === undefined)  runSnippetHeader = "#import \"Basic\";";
			runSnippetHeader.split(";").forEach(function (word) {
				word = word.trim();
				if (!snippet.match(word)) {
					prefix = prefix + word + ";\n";
				}
			});
			prefix += "\n";
			if (!snippet.match(/\bmain\s*::\s*\(\s*\)\s*{/)) {
				prefix += "main :: () {\n";
				postfix = "\n}\n";
			}

			snippet = prefix + snippet + postfix;

			let tempdir = os.tmpdir();
			let filepath = tempdir + path.sep + "jai_snippet.jai";
			fs.writeFileSync(filepath, snippet);
			let config = workspace.getConfiguration('the-language');
			let exepath = config.get("pathToJaiExecutable");
			if (exepath === undefined) { runningSnippet = false; return; }

			let outputpath = filepath.slice(0, filepath.length - 4);
			if (path.sep === "\\") outputpath += ".exe";

			if (fs.existsSync(outputpath))
				fs.unlinkSync(outputpath);
			Term.run(exepath + " " + filepath);
			Term.run(outputpath);
			runningSnippet = false;


		};
		context.subscriptions.push(commands.registerCommand(command, commandHandler));
	}
	return { languageService };
}

export function deactivate() {}

function loadAsmCompletions(): CompletionItem[] {
	let items: CompletionItem[] = [];

	let extension = extensions.getExtension("onelivesleft.the-language");
	if (extension === undefined) return items;
	let modulepath = path.sep === "\\"
		? path.join(extension.extensionPath, extension.extensionPath.toLowerCase().startsWith("c:\\repos") ? "src" : "out").replace(/\//, '\\')
		: path.join(extension.extensionPath, "out");

	let asmJSON = fs.readFileSync(path.resolve(modulepath, "asmCommands.json"), "utf8");
	let completions = JSON.parse(asmJSON);

	for (const completion in completions) {
		let info = completions[completion];
		let name = completion.padEnd(20, " ");
		let detail : string = info.detail[0];
		let first_doc_line : string = "";
		if (info.documentation !== undefined)
			first_doc_line = info.documentation[0];

		if (!detail) detail = first_doc_line;
		name += detail;

		let item = new CompletionItem(name, CompletionItemKind.Keyword);
		item.insertText = completion;

		// A human-readable string with additional information
		// about this item, like type or symbol information.
		item.detail = detail;

		// A human-readable string that represents a doc-comment.
		if (info.documentation !== undefined) {
			item.documentation = "";
			let doubleLine = true;
			for (let i = 0; i < info.documentation.length; i++) {
				if (info.documentation[i] === "Flags Affected:")
					doubleLine = false;
				item.documentation += info.documentation[i] + "\n";
				if (doubleLine) item.documentation += "\n";
			}
		}

		if (info.operands) {
			if (item.documentation)
				item.documentation = " " + info.operands.join("\n ") + "\n\n" + item.documentation;
			else
				item.documentation = " " + info.operands.join("\n ");
		}

		let url : string = info.url;
		asmURLs[completion] = url;

		items.push(item);
	}

	return items;
}



function triggerUpdateDecorations() {
	if (editTimeout) {
		clearTimeout(editTimeout);
		editTimeout = undefined;
	}
	editTimeout = setTimeout(updateSelectionAndDecorations, 500);
}

let activeEditor = window.activeTextEditor;


function updateSelectionAndDecorations() {
	if (!activeEditor) return;

	selections = [];
	let s = activeEditor.selections;
	for(let i = 0; i < s.length; i++)
		selections.push(s[i]);

	updateDecorations();
	updateAsm(activeEditor.document.getText());
}


function updateDecorations() {
	if (!activeEditor) return;

	console.log('activeEditor: ', activeEditor);

	decorate(activeEditor);
}


function makeDecoration(color: string): TextEditorDecorationType {
	return window.createTextEditorDecorationType({
		backgroundColor: color,
		isWholeLine: true,
	});
}


interface EmbedLanguageColor {
	language: string;
	color: string;
}


let debugMode : boolean | undefined = false;
let decorateEmbeds : boolean | undefined = true;
let runSnippetHeader : string | undefined = "";
let embedColorsConfig: EmbedLanguageColor[] | undefined;
let embedColors: { [language: string] : string};
let defaultEmbedColor = "#222222";
let embedDecorations: { [color: string] : TextEditorDecorationType } = {};


function updateConfig() {
	let config = workspace.getConfiguration('the-language');
	decorateEmbeds = config.get("decorateEmbeds");
	if (decorateEmbeds === undefined) decorateEmbeds = true;

	debugMode = config.get("debugMode");
	if (debugMode === undefined) debugMode = false;

	runSnippetHeader = config.get("runSnippetHeader");
	if (runSnippetHeader === undefined) runSnippetHeader = "#import \"Basic\";";

	embedColorsConfig = config.get("embedColors");
	if (embedColorsConfig !== undefined) {
		const isColor = /#[a-fA-F0-9]{6}/;
		embedColors = {};
		for (let i = 0; i < embedColorsConfig.length; i++) {
			let embedColor : EmbedLanguageColor = embedColorsConfig[i];
			if (embedColor.color.match(isColor)) {
				if (!(embedColor.color in embedDecorations))
					embedDecorations[embedColor.color] = makeDecoration(embedColor.color);
				if (embedColor.language.toLowerCase() === "default")
					defaultEmbedColor = embedColor.color;
				else
					embedColors[embedColor.language] = embedColor.color;
			}
		}
	}
	updateSelectionAndDecorations();
}


function areIntersecting(rangesA: Range [], rangesB: Range []): boolean {
	if (rangesA === undefined || rangesB === undefined) return false;

	for (let i = 0; i < rangesA.length; i++) {
		for (let j = 0; j < rangesB.length; j++) {
			if (rangesA[i] === undefined || rangesB[j] === undefined)
				return false;
			if (rangesA[i].intersection(rangesB[j]))
				return true;
		}
	}
	return false;
}


function subtract(range: Range, sorted_subtractors: Range []): [Range [], boolean] {
	let result: Range [] = [];
	let remainder: Range | undefined;
	remainder = range;
	let changed = false;

	for (let i = 0; i < sorted_subtractors.length; i++) {
		let to_remove = sorted_subtractors[i];
		if (to_remove.end.isBeforeOrEqual(remainder.start)) continue;
		if (to_remove.start.isAfterOrEqual(remainder.end)) continue;

		if (to_remove.start.isBeforeOrEqual(remainder.start)) {
			if (to_remove.end.isAfterOrEqual(remainder.end)) {
				changed = true;
				remainder = undefined;
				break;
			}
			else {
				changed = true;
				remainder = new Range(to_remove.end, remainder.end);
			}
		}
		else if (to_remove.end.isAfterOrEqual(remainder.end)) {
			changed = true;
			result.push(new Range(remainder.start, to_remove.start));
			remainder = undefined;
			break;
		}
		else { // to_subtract is strictly within range
			changed = true;
			result.push(new Range(remainder.start, to_remove.start));
			remainder = new Range(to_remove.end, remainder.end);
		}
	}

	if (remainder)
		result.push(remainder);

	return [result, changed];
}


enum FoldType {
	Import, Comment, Block
}

type char = number;

function decorate(editor: TextEditor) {
	if (!decorateEmbeds) {
		for (let color in embedDecorations) {
			editor.setDecorations(embedDecorations[color], []);
		}
		return;
	}

	let sourceCode = editor.document.getText();
	let hereString = /#string\s+([a-zA-Z_]\w*)\s*$/;
	let blockComment = /^\s*\/\*/;
	let docComment = /^\s*\/\*\*/;

	let decorationsArrays: { [color: string] : DecorationOptions[] } = {};

	const sourceCodeArr = sourceCode.split('\n');

	let endToken : string | undefined;
	let decorationColor = defaultEmbedColor;
	let startLine = 0;
	let insideDocComment = false;
	let insideBlockComment = false;
	let commentDepth = 0;
	decorationRanges = [];
	foldingRanges = [];

	let documentRange = editor.document.validateRange(new Range(editor.document.positionAt(0), editor.document.validatePosition(editor.document.positionAt(9999999))));
	//documentSymbols = [new DocumentSymbol(path.basename(editor.document.fileName), "", SymbolKind.File, documentRange, documentRange)];
	documentSymbols = [];
	let documentSymbolStack : DocumentSymbol[] = [];
	// The root documentSymbol is the #scope: if there are no #scope directives in the file this will be the entire document
	// 		If there are #scope directives, this will be amended to be the top section (default #scope_export) until the first #scope

	enum ParseState {
		Dormant, InExpression, InString, InStringEscaped, InHereString, InBlockComment, Error
	}
	let parseState = ParseState.Dormant as ParseState;
	let parseStateBeforeComment = ParseState.Dormant as ParseState;
	let inFirstTokenOfExpression = false;
	let firstTokenOfExpression = '';
	let expressionStartIndex = 0;
	let expressionStartLine = 0;

	const chara: char = 'a'.charCodeAt(0);
	const charg: char = 'g'.charCodeAt(0);
	const charz: char = 'z'.charCodeAt(0);
	const charA: char = 'A'.charCodeAt(0);
	const charZ: char = 'Z'.charCodeAt(0);
	const char0: char = '0'.charCodeAt(0);
	const char9: char = '9'.charCodeAt(0);
	const char_: char = '_'.charCodeAt(0);
	const charSpace: char = ' '.charCodeAt(0);
	const charQuote: char = '"'.charCodeAt(0);
	const charBackslash: char = '\\'.charCodeAt(0);
	const charStar: char = '*'.charCodeAt(0);
	const charSlash: char = '/'.charCodeAt(0);
	const charNull: char = '\0'.charCodeAt(0);
	const charSemicolon: char = ';'.charCodeAt(0);
	const charOpenBracket: char = '{'.charCodeAt(0);
	const charCloseBracket: char = '}'.charCodeAt(0);
	function isAlpha(c: char): boolean { return c >= chara && c <= charz || c >= charA && c <= charZ; }
	function isAlpha_(c: char): boolean { return isAlpha(c) || c === char_; }
	function isAlNum(c: char): boolean { return isAlpha(c) || c >= char0 && c <= char9; }
	function isAlNum_(c: char): boolean { return isAlNum(c) || c === char_; }

	for (let line = 0; line < sourceCodeArr.length; line++) {
		let lineText = sourceCodeArr[line];
		let lineTextTrimmed = lineText.trim();
		let c = charNull;
		for (let index = 0; index < lineText.length; index++) {
			const prev = c;
			c = lineText.charCodeAt(index);
			let break_to_next_line = false;

			if (parseState === ParseState.Dormant || parseState === ParseState.InExpression) {
				if (parseState === ParseState.Dormant) {
					if (c <= charSpace) continue;

					if (isAlpha_(c)) {
						inFirstTokenOfExpression = true;
						expressionStartLine = line;
						expressionStartIndex = index;
						parseState = ParseState.InExpression;
					}
				}

				if (inFirstTokenOfExpression) {
					if (!isAlNum_(c)) {
						inFirstTokenOfExpression = false;
						firstTokenOfExpression = lineText.substring(expressionStartIndex, index);
					}
				}

				if (c <= charSpace) continue;

				if (c === charQuote) {
					parseState = ParseState.InString;
				}
				else if (c === charSlash) {
					if (prev === charSlash) // line comment, so ignore rest of line
						break_to_next_line = true;
				}
				else if (c === charStar) {
					if (prev === charSlash)
						parseState = ParseState.InBlockComment;
				}
				else if (c === charSemicolon) {
					parseState = ParseState.Dormant;
				}
				else if (c === charOpenBracket) {
					let range = editor.document.validateRange(new Range(new Position(line, index), editor.document.validatePosition(editor.document.positionAt(9999999))));
					let name = lineText.substring(0, index).trim();
					if(name !== '') {
						let symbolKind = symbolKindFromName(name);
						let documentSymbol = new DocumentSymbol(name, "", symbolKind, range, range);
						let parentSymbolList = documentSymbolStack.length > 0 ? documentSymbolStack[documentSymbolStack.length - 1].children : documentSymbols;
						parentSymbolList.push(documentSymbol);
						documentSymbolStack.push(documentSymbol);
					}
				}
				else if (c === charCloseBracket) {
					let documentSymbol = documentSymbolStack.pop();
					if (documentSymbol) {
						let position = editor.document.validatePosition(new Position(line, index));
						let range = editor.document.validateRange(new Range(documentSymbol.range.start, position));
						documentSymbol.range = range;
						documentSymbol.selectionRange = range;
					}
				}

				if (break_to_next_line) break;
				continue;
			}

			switch (parseState) {
				case ParseState.InString:{
					if (c === charQuote)
						parseState = ParseState.InExpression;
					else if (c === charBackslash)
						parseState = ParseState.InStringEscaped;
					break;
				}
				case ParseState.InStringEscaped:{
					parseState = ParseState.InString;
					break;
				}
				case ParseState.InHereString:{
					if (lineTextTrimmed.startsWith(endToken as string)) {
						parseState = ParseState.InExpression;
						index = lineText.indexOf(endToken as string) + (endToken as string).length - 1;
					}
					else {
						break_to_next_line = true;
					}
					break;
				}
				case ParseState.InBlockComment:{
					if (c === charStar) {
						if (prev === charSlash) {
							commentDepth++;
							c = charNull; // so we don't trigger on `/*/`
						}
					}
					else if (c === charSlash) {
						if (prev === charStar) commentDepth--;
						if (commentDepth === 0) parseState = parseStateBeforeComment;
					}
					break;
				}
			}
			if (break_to_next_line || parseState === ParseState.Error) break;
		}
		if (parseState === ParseState.Error) break;
	}

	for (let i = 0; i < documentSymbols.length; i++) {
		let symbol = documentSymbols[i];
		foldingRanges.push(new FoldingRange(symbol.range.start.line, symbol.range.end.line));
	}

	commentDepth = 0;
	let regionStart = -1;
	let importStart = -1;
	let commentStart = -1;
	let blockStart = -1;
	let parenStart = -1;

	selectionsIntersectDecoration = false;
	let trimmedLineText : string = "";
	const eol = 99999;

	for (let line = 0; line < sourceCodeArr.length; line++) {
		let lineText = sourceCodeArr[line];
		let prevLineWasEmpty = trimmedLineText === "";
		trimmedLineText = lineText.trim();

		if (endToken !== undefined) {
			if (insideBlockComment || insideDocComment) {
				if (lineText.indexOf("/*") >= 0)
					commentDepth++;
			}

			let match = lineText.match(endToken);
			if (match !== null || line === sourceCodeArr.length - 1) {

				let endLine = (insideBlockComment || insideDocComment) ? line : line - 1;

				if (insideBlockComment) {
					commentDepth--;
					if (commentDepth > 0) continue;
					//foldingRanges.push(new FoldingRange(startLine, endLine, FoldingRangeKind.Comment));
				}
				else if (insideDocComment) {
					commentDepth--;
					if (commentDepth > 0) continue;
					//foldingRanges.push(new FoldingRange(startLine, endLine, FoldingRangeKind.Comment));
				}
				else { // herestring
					//foldingRanges.push(new FoldingRange(startLine, endLine));
				}

				endToken = undefined;

				if (insideBlockComment) {
					insideBlockComment = false;
					continue;
				}

				let range = new Range(
					new Position(startLine, 0),
					new Position(endLine, eol)
				);
				decorationRanges.push(range);

				if (!(decorationColor in decorationsArrays))
					decorationsArrays[decorationColor] = [];

				let [applicableRanges, changed] = subtract(range, selections); // @Note assumes selections are ordered and disjoint
				if (changed) selectionsIntersectDecoration = true;

				for (let i = 0; i < applicableRanges.length; i++) {
					range = applicableRanges[i];
					if (range.start.character !== 0) {
						if (range.start.line + 1 > range.end.line) continue;
						range = new Range(
							new Position(range.start.line + 1, 0),
							range.end
						);
					}
					if (range.end.character !== eol) {
						if (range.end.line - 1 < range.start.line) continue;
						range = new Range(
							range.start,
							new Position(range.end.line - 1, eol),
						);
					}

					let decoration = { range };
					decorationsArrays[decorationColor].push(decoration);
				}
			}
		}
		else {
			let handled = false;

			if (!insideDocComment && !insideBlockComment) {
				if (trimmedLineText.startsWith("#scope_")) {
					//if (regionStart >= 0)
					//	foldingRanges.push(new FoldingRange(regionStart, line - 1, FoldingRangeKind.Region));
					regionStart = line;
					handled = true;
				}

				if (importStart >= 0) {
					if (trimmedLineText.indexOf("#import") === -1
					 && trimmedLineText.indexOf("#load") === -1
					 && trimmedLineText !== "") {
						let lineIndex = line - 1;
						if (prevLineWasEmpty) lineIndex--;
						//if (lineIndex > importStart)
						//	foldingRanges.push(new FoldingRange(importStart, lineIndex, FoldingRangeKind.Imports));
						importStart = -1;
					}
				}
				else if (trimmedLineText.indexOf("#import") >= 0
					|| trimmedLineText.indexOf("#load") >= 0) {
					importStart = line;
					handled = true;
				}

				if (commentStart >= 0) {
					if (!trimmedLineText.startsWith("//")
					&&  trimmedLineText !== "") {
						let lineIndex = line - 1;
						if (prevLineWasEmpty) lineIndex--;
						//if (lineIndex > commentStart)
						//	foldingRanges.push(new FoldingRange(commentStart, lineIndex, FoldingRangeKind.Comment));
						commentStart = -1;
					}
				}
				else if (trimmedLineText.startsWith("//")) {
					commentStart = line;
					handled = true;
				}

				if (blockStart >= 0) {
					if (lineText.startsWith("}")) {
						//if (line > blockStart + 1)
						//	foldingRanges.push(new FoldingRange(blockStart, line));
						blockStart = -1;
					}
				}
				else if (!lineText.startsWith(" ") && trimmedLineText.endsWith("{")) {
					blockStart = line;
					handled = true;
				}

				if (parenStart >= 0) {
					if (lineText.startsWith(")")) {
						//if (line > parenStart + 1)
						//	foldingRanges.push(new FoldingRange(parenStart, line));
						parenStart = -1;
					}
				}
				else if (!lineText.startsWith(" ") && trimmedLineText.endsWith("(")) {
					parenStart = line;
					handled = true;
				}
			}

			if (handled) continue;

			let match = lineText.match(hereString);
			let isHereString = true;

			if ((match === null || match.index === undefined) && !trimmedLineText.endsWith("*/")) {
				match = lineText.match(docComment);
				isHereString = false;

				if (match === null || match.index === undefined) {
					match = lineText.match(blockComment);
					if (match && match.index !== undefined) {
						startLine = line;
						insideBlockComment = true;
						insideDocComment = false;
						commentDepth = 1;
						isHereString = false;
						endToken = "\\*\\/";
						continue;
					}
				}
			}

			if (match !== null && match.index !== undefined) {
				let matchedLanguage: string;
				if (isHereString) {
					startLine = line + 1;
					insideDocComment = false;
					matchedLanguage = match[1];
					endToken = matchedLanguage;
				}
				else {
					startLine = line;
					insideDocComment = true;
					commentDepth = 1;
					matchedLanguage = "md";
					endToken = "\\*\\/";
				}

				decorationColor = defaultEmbedColor;
				for (let i = 0; i < supportedLanguages.length; i++) {
					let language = supportedLanguages[i][0] as string;
					let pattern  = supportedLanguages[i][1] as RegExp;
					if (matchedLanguage.match(pattern))
					{
						if (language in embedColors)
							decorationColor = embedColors[language];
						break;
					}
				}
			}
		}
	}

	let lastLine = sourceCodeArr.length - 1;
	if (sourceCodeArr[lastLine].trim() === "")
		lastLine--;

/*
	if (regionStart >= 0 && regionStart < lastLine)
		foldingRanges.push(new FoldingRange(regionStart, lastLine, FoldingRangeKind.Region));

	if (importStart >= 0 && importStart < lastLine)
		foldingRanges.push(new FoldingRange(importStart, lastLine, FoldingRangeKind.Imports));

	if (commentStart >= 0 && commentStart < lastLine)
		foldingRanges.push(new FoldingRange(commentStart, lastLine, FoldingRangeKind.Comment));

	if (blockStart >= 0 && blockStart < lastLine)
		foldingRanges.push(new FoldingRange(blockStart, lastLine));

	if (parenStart >= 0 && parenStart < lastLine)
		foldingRanges.push(new FoldingRange(parenStart, lastLine));
*/

	for (let color in decorationsArrays) {
		editor.setDecorations(embedDecorations[color], decorationsArrays[color]);
	}

	for (let color in embedDecorations) {
		if (!(color in decorationsArrays))
			editor.setDecorations(embedDecorations[color], []);
	}
}


function symbolKindFromName(name: string): SymbolKind {
	let parts = name.split(/\s+/, 3);
	if (parts.length < 3) return SymbolKind.Null;

	let middle = parts[1];
	let tail = parts[2];
	if (middle === "::" || middle === ":") {
		if (tail.startsWith("(") || tail === "inline") return SymbolKind.Function;
		if (tail === "struct") return SymbolKind.Struct;
		if (tail.startsWith("[")) return SymbolKind.Array;
		if (tail === "enum" || tail === "enum_flags") return SymbolKind.Enum;
	}

	return SymbolKind.Null;
}


function updateAsm(sourceCode: string) {
	let asmStart = /#asm\b.*{/;
	let asmEnd = "}";

	const sourceCodeArr = sourceCode.split('\n');

	let startLine = 0;
	let startChar = 0;
	let insideAsm = false;
	asmRanges = [];

	for (let line = 0; line < sourceCodeArr.length; line++) {
		let lineText = sourceCodeArr[line];
		if (insideAsm) {
			let match = lineText.match(asmEnd);

			if (match !== null || line === sourceCodeArr.length - 1) {
				let eol;
				if (match === null || match.index === undefined)
					eol = 99999;
				else
					eol = match.index + 1;
				let range = new Range(
					new Position(startLine, startChar),
					new Position(line, eol)
				);
				asmRanges.push(range);
				insideAsm = false;
			}
		}
		else {
			let match = lineText.match(asmStart);
			if (match === null || match.index === undefined) continue;
			let singleLineMatch = lineText.slice(match.index + match[0].length).match(asmEnd);
			if (singleLineMatch === null || singleLineMatch.index === undefined) {
				insideAsm = true;
				startLine = line;
				startChar = match.index + match[0].length;
			}
			else {
				let range = new Range(
					new Position(line, match.index + match[0].length),
					new Position(line, match.index + match[0].length + singleLineMatch.index + 1)
				);

				asmRanges.push(range);
			}
		}
	}
}


class JaiCompletionItemProvider implements CompletionItemProvider {
	public provideCompletionItems(document: TextDocument, position: Position,
								  token: CancellationToken, context: CompletionContext):
		Thenable<CompletionItem[]> {
		return new Promise((resolve, reject) => {
			let invalidCharacter = /[^a-z0-9]/;
			for (let i = 0; i < asmRanges.length; i++) {
				let range = asmRanges[i];
				if (range.contains(position)) {
					let line = document.getText().split("\n")[position.line];
					let startPos, endPos;
					const eol = 99999;
					if (position.line === range.start.line)
						startPos = range.start.character;
					else
						startPos = 0;
					if (position.line === range.end.line)
						endPos = range.end.character;
					else
						endPos = eol;
					line = line.slice(startPos, Math.min(position.character, endPos));
					let semicolon = line.lastIndexOf(";");
					if (semicolon >= 0)
					 	line = line.slice(semicolon + 1);
					line = line.trimLeft();
					let match = line.match(invalidCharacter);
					if (match === null) {
						if (asmCompletions.length === 0)
							asmCompletions = loadAsmCompletions();
						resolve(asmCompletions);
					}
					else
						reject();
					return;
				}
			}
			reject();
		});
    }
}


class JaiFoldingRangeProvider implements FoldingRangeProvider {
	public provideFoldingRanges(document: TextDocument): ProviderResult<FoldingRange[]> {
		return new Promise(resolve => {
			resolve(foldingRanges);
		});
	}
}


class JaiDefinitionProvider implements DefinitionProvider {
    public async provideDefinition(document: TextDocument, position: Position): Promise<Location[]> {
        if (path.basename(document.fileName).startsWith(".added_strings_")) {
            const lines = document.getText().split("\n");
            for (let row = position.line; row >= 0; row--) {
                const origin = /\/\/ .*Generated from (.*):([0-9]+)\./.exec(lines[row]);
                if (origin) {
                    return [new Location(Uri.file(origin[1]), new Position(Math.max(0, Number(origin[2]) - 1), 0))];
                }
            }
        }
        // Preserve x64 instruction documentation without applying the active
        // editor's assembly ranges to requests for another document.
        if (activeEditor?.document === document && asmRanges.some(range => range.contains(position))) {
            const wordRange = document.getWordRangeAtPosition(position);
            if (wordRange) {
                if (asmCompletions.length === 0) { asmCompletions = loadAsmCompletions(); }
                const url = asmURLs[document.getText(wordRange)];
                if (url) { await env.openExternal(Uri.parse(url)); return []; }
            }
        }
        return languageService.provideDefinition(document, position);
    }
}


class Term {
	static termName: string = "jai-terminal";
	static term: Terminal | undefined; //eslint-disable-line no-undef

	static _term() {
		if (!Term.term) {
			Term.term = window.createTerminal(Term.termName);
			Term.term.show(true);
			window.onDidCloseTerminal(event => {
				if (Term._term() && event.name === Term.termName) {
					Term.term = undefined;
				}
			});
		}
		return Term.term;
	}

	static run(command: string) {
		Term._term().sendText(command, true);
	}

	static dispose() {
		if (Term._term()) {
			Term._term().dispose();
			Term.term = undefined;
		}
	}
}
