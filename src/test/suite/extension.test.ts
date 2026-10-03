import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JaiLanguageService } from '../../service';

suite('Jai editor features', () => {
    let directory: string;
    let service: JaiLanguageService;
    let main: vscode.TextDocument;
    let helper: vscode.TextDocument;
    let configuration: vscode.WorkspaceConfiguration;
    let previousBackground: boolean | undefined;
    const source = '#load "helper.jai";\nmain :: () {\n    box: Box;\n    result := make(1, 2);\n    box.value = result.value;\n    literal := Box.{3};\n}\n';
    const library = '// A container.\nBox :: struct { value: int; }\n/** Builds a box. */\nmake :: (first: int, second: int) -> Box { return Box.{first + second}; }\n';
    function position(document: vscode.TextDocument, needle: string, inside = 0): vscode.Position {
        const offset = document.getText().indexOf(needle);
        assert.ok(offset >= 0, `Missing ${needle}`);
        return document.positionAt(offset + inside);
    }
    suiteSetup(async () => {
        directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'jai-editor-test-'));
        fs.writeFileSync(path.join(directory, 'main.jai'), source);
        fs.writeFileSync(path.join(directory, 'helper.jai'), library);
        configuration = vscode.workspace.getConfiguration('the-language');
        previousBackground = configuration.inspect<boolean>('enableBackgroundCompilation')?.globalValue;
        await configuration.update('enableBackgroundCompilation', false, vscode.ConfigurationTarget.Global);
        main = await vscode.workspace.openTextDocument(path.join(directory, 'main.jai'));
        helper = await vscode.workspace.openTextDocument(path.join(directory, 'helper.jai'));
        const extension = vscode.extensions.getExtension('onelivesleft.the-language')!;
        service = (await extension.activate()).languageService;
    });
    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await configuration.update('enableBackgroundCompilation', previousBackground, vscode.ConfigurationTarget.Global);
        fs.rmdirSync(directory, { recursive: true });
    });
    test('Resolves load paths, cross-file symbols and types without a successful compilation', async () => {
        const imported = await service.provideDefinition(main, position(main, 'helper.jai'));
        assert.strictEqual(imported[0].uri.fsPath, helper.fileName);
        const definition = await service.provideDefinition(main, position(main, 'make(1'));
        assert.strictEqual(definition[0].uri.fsPath, helper.fileName);
        assert.strictEqual(definition[0].range.start.line, 3);
        const type = await service.provideTypeDefinition(main, position(main, 'box.value'));
        assert.strictEqual(type[0].range.start.line, 1);
    });
    test('Provides docs, member completions, parameter hints and complete document symbols', async () => {
        const hover = await service.provideHover(main, position(main, 'make(1'));
        assert.ok(hover);
        assert.ok((hover!.contents[0] as vscode.MarkdownString).value.includes('Builds a box.'));
        const members = await service.provideCompletionItems(main, position(main, 'box.value', 4));
        assert.ok(members.some(item => item.label === 'value'));
        const inferred = await service.provideCompletionItems(main, position(main, 'result.value', 7));
        assert.ok(inferred.some(item => item.label === 'value'));
        const literals = await service.provideTypeDefinition(main, position(main, 'literal :='));
        assert.strictEqual(literals[0].range.start.line, 1);
        const signature = await service.provideSignatureHelp(main, position(main, 'make(1, 2)', 8));
        assert.strictEqual(signature!.activeParameter, 1);
        assert.strictEqual(signature!.signatures[0].parameters.length, 2);
        const outline = service.provideDocumentSymbols(helper);
        assert.ok(outline.find(item => item.name === 'Box')!.children.some(item => item.name === 'value'));
    });
    test('Finds cross-file definitions through the registered VS Code provider', async () => {
        const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', main.uri, position(main, 'make(1'));
        assert.strictEqual(definitions![0].uri.fsPath, helper.fileName);
    });
    test('Finds workspace declarations and completes import filenames', async () => {
        const token = new vscode.CancellationTokenSource();
        try {
            const symbols = await service.provideWorkspaceSymbols('make', token.token);
            assert.ok(symbols.some(symbol => symbol.name === 'make' && symbol.location.uri.fsPath === helper.fileName));
        } finally { token.dispose(); }
        const imports = await service.provideCompletionItems(main, position(main, 'helper.jai', 3));
        assert.ok(imports.some(item => item.label === 'helper.jai'));
    });
    test('Uses unsaved buffers, resolves shadowing and renames only the correct local binding', async () => {
        const text = 'main :: () {\n    value := 1;\n    { value := 2; print(value); }\n    print(value);\n}\n';
        const edit = new vscode.WorkspaceEdit(); edit.replace(main.uri, new vscode.Range(main.positionAt(0), main.positionAt(main.getText().length)), text);
        await vscode.workspace.applyEdit(edit);
        const use = main.positionAt(main.getText().lastIndexOf('value'));
        const definitions = await service.provideDefinition(main, use);
        assert.strictEqual(definitions[0].range.start.line, 1);
        const renamed = await service.provideRenameEdits(main, use, 'count');
        assert.deepStrictEqual(renamed.get(main.uri).map(item => item.range.start.line), [1, 3]);
        await assert.rejects(service.provideRenameEdits(main, use, 'return'));
        const restore = new vscode.WorkspaceEdit(); restore.replace(main.uri, new vscode.Range(main.positionAt(0), main.positionAt(main.getText().length)), source);
        await vscode.workspace.applyEdit(restore);
        await main.save();
    });
    test('Refreshes compiler references after saving a helper file without main', async function () {
        this.timeout(20000);
        await service.refresh(main);
        const use = position(main, 'make(1');
        const references = await service.provideReferences(main, use, { includeDeclaration: true });
        assert.strictEqual(references.length, 2, 'Expected both compiler declaration and call locations');
        const edit = new vscode.WorkspaceEdit(); edit.insert(helper.uri, new vscode.Position(0, 0), '// unsaved edit\n');
        await vscode.workspace.applyEdit(edit);
        const shifted = await service.provideDefinition(main, use);
        assert.strictEqual(shifted[0].range.start.line, 4, 'Must not reuse the old compiler position');
        await helper.save();
        // Background save uses the same scheduling path; explicit refresh removes
        // timing dependencies from the compiler assertions.
        await service.refresh(helper);
        const rename = await service.provideRenameEdits(main, use, 'create_box');
        assert.strictEqual(rename.get(main.uri).length, 1);
        assert.strictEqual(rename.get(helper.uri).length, 1);
        assert.strictEqual(rename.get(helper.uri)[0].range.start.line, 4);
    });
    test('Publishes compiler diagnostics and clears them after the error is fixed', async function () {
        this.timeout(20000);
        const saved = helper.getText();
        const invalid = new vscode.WorkspaceEdit(); invalid.insert(helper.uri, new vscode.Position(0, 0), 'invalid :: MISSING_JAI_TYPE;\n');
        await vscode.workspace.applyEdit(invalid); await helper.save();
        await service.refresh(helper);
        assert.ok(vscode.languages.getDiagnostics(helper.uri).some(diagnostic => diagnostic.source === 'Jai' && diagnostic.severity === vscode.DiagnosticSeverity.Error));
        const restore = new vscode.WorkspaceEdit(); restore.replace(helper.uri, new vscode.Range(helper.positionAt(0), helper.positionAt(helper.getText().length)), saved);
        await vscode.workspace.applyEdit(restore); await helper.save();
        await service.refresh(helper);
        assert.strictEqual(vscode.languages.getDiagnostics(helper.uri).length, 0);
    });
    test('Automatically rebuilds the project when a helper without main is saved', async function () {
        this.timeout(20000);
        await configuration.update('enableBackgroundCompilation', true, vscode.ConfigurationTarget.Global);
        try {
            await service.refresh(main);
            const edit = new vscode.WorkspaceEdit(); edit.insert(helper.uri, new vscode.Position(0, 0), '// background refresh\n');
            await vscode.workspace.applyEdit(edit); await helper.save();
            const deadline = Date.now() + 12000;
            let references: vscode.Location[] = [];
            while (Date.now() < deadline) {
                references = await service.provideReferences(main, position(main, 'make(1'), { includeDeclaration: true });
                if (references.length === 2) { break; }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.strictEqual(references.length, 2, 'Save must trigger the compiler without an explicit refresh');
            assert.ok(references.some(location => location.uri.fsPath === helper.fileName && location.range.start.line === 5));
        } finally { await configuration.update('enableBackgroundCompilation', false, vscode.ConfigurationTarget.Global); }
    });
});
