import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JaiFile, JaiImport, JaiSymbol, parseFile, tokenAt, callAt, splitArguments, byteColumnToCharacter } from './analysis';
import { CompilerProcess, CompilerReference, SourceRange, fileKey, resolveCompiler, parseReferences, sentinel } from './compiler';

interface LocatedSymbol { file: JaiFile; symbol: JaiSymbol; }
interface Project {
    root: string; generation: number; references: CompilerReference[]; snapshots: Map<string, string>;
    timer?: NodeJS.Timeout; process?: CompilerProcess; diagnostics: vscode.Uri[];
}

const symbolKinds: { [kind: string]: vscode.SymbolKind } = {
    function: vscode.SymbolKind.Function, struct: vscode.SymbolKind.Struct, enum: vscode.SymbolKind.Enum,
    variable: vscode.SymbolKind.Variable, constant: vscode.SymbolKind.Constant,
    module: vscode.SymbolKind.Module, parameter: vscode.SymbolKind.Variable
};
const completionKinds: { [kind: string]: vscode.CompletionItemKind } = {
    function: vscode.CompletionItemKind.Function, struct: vscode.CompletionItemKind.Struct, enum: vscode.CompletionItemKind.Enum,
    variable: vscode.CompletionItemKind.Variable, constant: vscode.CompletionItemKind.Constant,
    module: vscode.CompletionItemKind.Module, parameter: vscode.CompletionItemKind.Variable
};

export class JaiLanguageService implements vscode.DefinitionProvider, vscode.TypeDefinitionProvider,
    vscode.ReferenceProvider, vscode.RenameProvider, vscode.HoverProvider, vscode.SignatureHelpProvider,
    vscode.CompletionItemProvider, vscode.DocumentSymbolProvider, vscode.WorkspaceSymbolProvider, vscode.Disposable {
    private files = new Map<string, JaiFile>();
    private projects = new Map<string, Project>();
    private output = vscode.window.createOutputChannel('Jai');
    private diagnostics = vscode.languages.createDiagnosticCollection('jai');
    private disposed = false;

    constructor(private context: vscode.ExtensionContext) {
        context.subscriptions.push(this, this.output, this.diagnostics);
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => this.changed(document, true)));
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => this.changed(document, true)));
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => this.changed(event.document, false)));
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
            this.files.delete(fileKey(document.fileName));
            if (document.languageId === 'jai') { this.changed(document, true); }
        }));
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('the-language')) { return; }
            this.reset();
            vscode.workspace.textDocuments.forEach(document => this.changed(document, true));
        }));
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.jai');
        context.subscriptions.push(watcher, watcher.onDidChange(uri => this.diskChanged(uri)),
            watcher.onDidCreate(uri => this.diskChanged(uri)), watcher.onDidDelete(uri => this.diskChanged(uri)));
        vscode.workspace.textDocuments.forEach(document => this.changed(document, true));
    }

    dispose(): void { this.disposed = true; this.reset(); }
    async refresh(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'jai' || document.uri.scheme !== 'file') { return; }
        const project = this.project(document.fileName);
        project.generation++; project.references = []; project.process?.cancel();
        if (project.timer) { clearTimeout(project.timer); project.timer = undefined; }
        await this.compile(project);
    }
    private reset(): void {
        for (const project of this.projects.values()) {
            if (project.timer) { clearTimeout(project.timer); }
            project.process?.cancel();
        }
        this.projects.clear(); this.files.clear(); this.diagnostics.clear();
    }
    private diskChanged(uri: vscode.Uri): void {
        if (/[\\/]\.build[\\/]|\.added_strings_\d+\.jai$/i.test(uri.fsPath)) { return; }
        // VS Code emits a save event and, later, a filesystem event for the same
        // write. The latter must not cancel a fresh analysis of that saved text.
        const open = vscode.workspace.textDocuments.find(document => fileKey(document.fileName) === fileKey(uri.fsPath));
        if (open && !open.isDirty) {
            try { if (fs.readFileSync(uri.fsPath, 'utf8') === open.getText()) { return; } } catch { /* Deleted file. */ }
        }
        this.files.delete(fileKey(uri.fsPath));
        for (const project of this.projects.values()) {
            if (project.snapshots.has(fileKey(uri.fsPath)) || vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath === vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root))?.uri.fsPath) {
                this.schedule(project);
            }
        }
    }
    private config(file: string): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('the-language', vscode.Uri.file(file));
    }
    private compiler(file: string): string | undefined { return resolveCompiler(this.config(file).get<string>('pathToJaiExecutable', 'jai')); }
    private root(file: string): string {
        const configured = this.config(file).get<string>('projectFile', '');
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
        const base = folder?.uri.fsPath || path.dirname(file);
        if (configured) { return path.resolve(base, configured.replace(/\$\{workspaceFolder\}/g, base)); }
        for (const project of this.projects.values()) {
            if (project.snapshots.has(fileKey(file))) { return project.root; }
        }
        // Use a conventional build entry point when opening a helper source file.
        for (const name of ['build.jai', 'main.jai', 'first.jai']) {
            const candidate = path.join(base, name);
            if (fs.existsSync(candidate)) { return candidate; }
        }
        return file;
    }
    private project(file: string): Project {
        const root = this.root(file); const key = fileKey(root);
        let project = this.projects.get(key);
        if (!project) {
            project = { root, generation: 0, references: [], snapshots: new Map(), diagnostics: [] };
            this.projects.set(key, project);
        }
        return project;
    }
    private changed(document: vscode.TextDocument, compile: boolean): void {
        if (document.languageId !== 'jai' || document.uri.scheme !== 'file' || this.disposed) { return; }
        this.files.delete(fileKey(document.fileName));
        const project = this.project(document.fileName);
        // Any edit invalidates locations, including edits in a loaded helper file.
        project.generation++; project.references = [];
        project.process?.cancel();
        if (project.timer) { clearTimeout(project.timer); project.timer = undefined; }
        this.diagnostics.delete(document.uri);
        if (compile) { this.schedule(project); }
    }
    private schedule(project: Project): void {
        project.generation++; project.references = []; project.process?.cancel();
        if (project.timer) { clearTimeout(project.timer); }
        if (!this.config(project.root).get<boolean>('enableBackgroundCompilation', true)) { return; }
        project.timer = setTimeout(() => { project.timer = undefined; void this.compile(project); }, 500);
    }
    private read(file: string): string | undefined {
        const open = vscode.workspace.textDocuments.find(document => fileKey(document.fileName) === fileKey(file));
        if (open) { return open.getText(); }
        try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    }
    private file(file: string): JaiFile | undefined {
        const text = this.read(file); if (text === undefined) { return undefined; }
        const key = fileKey(file); const cached = this.files.get(key);
        if (cached?.text === text) { return cached; }
        const parsed = parseFile(path.resolve(file), text);
        this.files.set(key, parsed); return parsed;
    }
    private moduleDirs(file: string): string[] {
        const args = splitArguments(this.config(file).get<string>('projectJaiArgs', ''));
        const root = path.dirname(this.root(file)); const result: string[] = [];
        for (let i = 0; i < args.length - 1; i++) {
            if (['-import_dir', 'import_dir'].includes(args[i])) { result.push(path.resolve(root, args[++i])); }
        }
        const executable = this.compiler(file);
        if (executable) { result.push(path.resolve(path.dirname(executable), '../modules')); }
        return result;
    }
    private resolveImport(file: JaiFile, item: JaiImport): string | undefined {
        if (item.kind === 'import,string') { return undefined; }
        const direct = item.kind === 'load' || item.kind === 'import,file';
        const roots = direct ? [path.dirname(file.path)] : this.moduleDirs(file.path);
        if (path.isAbsolute(item.name)) { roots.unshift(''); }
        for (const directory of roots) {
            const base = path.resolve(directory, item.name);
            const candidates = direct ? [base] : item.kind === 'import,dir' ? [path.join(base, 'module.jai')] : [path.join(base, 'module.jai'), base + '.jai'];
            for (const candidate of candidates) {
                try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { /* Try the next module root. */ }
            }
        }
        return undefined;
    }
    private dependencies(file: JaiFile): { file: JaiFile; item: JaiImport }[] {
        const result: { file: JaiFile; item: JaiImport }[] = [];
        for (const item of file.imports) {
            const target = this.resolveImport(file, item); const parsed = target ? this.file(target) : undefined;
            if (parsed) { result.push({ file: parsed, item }); }
        }
        return result;
    }
    private exports(file: JaiFile, includeModule: boolean, visited = new Set<string>()): LocatedSymbol[] {
        const key = fileKey(file.path); if (visited.has(key)) { return []; } visited.add(key);
        const result = file.symbols.filter(symbol => !symbol.owner && symbol.scopeStart === 0 && symbol.visibility !== 'file'
            && (includeModule || symbol.visibility === 'export')).map(symbol => ({ file, symbol }));
        for (const dependency of this.dependencies(file)) {
            if (!dependency.item.alias && dependency.item.kind === 'load') {
                result.push(...this.exports(dependency.file, includeModule, visited));
            }
        }
        return result;
    }
    private visible(file: JaiFile, offset: number): LocatedSymbol[] {
        const local = file.symbols.filter(symbol => (!symbol.owner || !['struct', 'enum'].includes(symbol.owner.kind))
            && symbol.scopeStart <= offset && offset <= symbol.scopeEnd
            && (symbol.scopeStart === 0 || ['constant', 'function', 'struct', 'enum', 'module', 'parameter'].includes(symbol.kind) || symbol.start <= offset));
        local.sort((a, b) => b.scopeStart - a.scopeStart || b.start - a.start);
        const result = local.map(symbol => ({ file, symbol }));
        for (const dependency of this.dependencies(file)) {
            if (!dependency.item.alias) { result.push(...this.exports(dependency.file, dependency.item.kind === 'load')); }
        }
        return result;
    }
    private lookup(file: JaiFile, name: string, offset: number): LocatedSymbol[] {
        const candidates = this.visible(file, offset).filter(item => item.symbol.name === name);
        if (!candidates.length) { return []; }
        const first = candidates[0];
        return candidates.filter(item => item.file === first.file && item.symbol.scopeStart === first.symbol.scopeStart);
    }
    private inferredType(item: LocatedSymbol, visited = new Set<JaiSymbol>()): string | undefined {
        const symbol = item.symbol;
        if (visited.has(symbol)) { return undefined; } visited.add(symbol);
        if (symbol.kind === 'struct' || symbol.kind === 'enum') { return symbol.name; }
        if (symbol.type) { return symbol.type.replace(/^(?:\*|\[[^\]]*\]\s*)+/, '').replace(/^\$+/, '').trim(); }
        const value = symbol.initializer?.replace(/^=\s*/, '') || '';
        if (value.startsWith('"') || value.startsWith('#string')) { return 'string'; }
        if (/^-?\d+(?:\.\d+)?$/.test(value)) { return value.includes('.') ? 'float' : 'int'; }
        if (['true', 'false'].includes(value)) { return 'bool'; }
        const composite = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\.\s*\{/.exec(value);
        if (composite) { return composite[1]; }
        const cast = /^(?:cast|xx)(?:,\w+)*\s*\(\s*([*\w.]+)/.exec(value);
        if (cast && cast[1]) { return cast[1].replace(/^\*+/, ''); }
        const call = /^([A-Za-z_]\w*)\s*\(/.exec(value);
        if (call) {
            const procedure = this.lookup(item.file, call[1], symbol.start).find(other => other.symbol.kind === 'function' || other.symbol.kind === 'struct');
            if (procedure) { return this.inferredType(procedure, visited); }
        }
        const ident = /^([A-Za-z_]\w*)$/.exec(value);
        if (ident) {
            const other = this.lookup(item.file, ident[1], symbol.start)[0];
            if (other) { return this.inferredType(other, visited); }
        }
        return undefined;
    }
    private members(item: LocatedSymbol, visited = new Set<JaiSymbol>()): LocatedSymbol[] {
        if (visited.has(item.symbol)) { return []; } visited.add(item.symbol);
        if (item.symbol.kind === 'module') {
            const imported = this.dependencies(item.file).find(dependency => dependency.item.alias === item.symbol.name);
            return imported ? this.exports(imported.file, false) : [];
        }
        let type = item;
        if (!['struct', 'enum'].includes(type.symbol.kind)) {
            const name = this.inferredType(item);
            if (!name) { return []; }
            const resolved = this.resolveName(item.file, name, item.symbol.start).find(other => ['struct', 'enum'].includes(other.symbol.kind));
            if (!resolved) { return []; } type = resolved;
        }
        const result = type.file.symbols.filter(symbol => symbol.owner === type.symbol && symbol.kind !== 'parameter').map(symbol => ({ file: type.file, symbol }));
        for (const member of result.slice()) { if (member.symbol.using) { result.push(...this.members(member, visited)); } }
        return result;
    }
    private resolveName(file: JaiFile, name: string, offset: number): LocatedSymbol[] {
        const names = name.split('.'); let result = this.lookup(file, names.shift()!, offset);
        for (const part of names) { result = result.flatMap(item => this.members(item)).filter(item => item.symbol.name === part); }
        return result;
    }
    private resolveAt(file: JaiFile, offset: number): LocatedSymbol[] {
        const token = tokenAt(file, offset);
        if (!token || token.kind !== 'name') { return []; }
        const declared = file.symbols.find(symbol => symbol.start === token.start);
        if (declared) { return [{ file, symbol: declared }]; }
        let i = file.tokens.indexOf(token); let name = token.text;
        while (i >= 2 && file.tokens[i - 1].text === '.' && file.tokens[i - 2].kind === 'name') {
            name = file.tokens[i - 2].text + '.' + name; i -= 2;
        }
        return this.resolveName(file, name, offset);
    }
    private symbolRange(item: LocatedSymbol): vscode.Location {
        const document = this.positions(item.file.text);
        return new vscode.Location(vscode.Uri.file(item.file.path), new vscode.Range(document(item.symbol.start), document(item.symbol.selectionEnd)));
    }
    private positions(text: string): (offset: number) => vscode.Position {
        const starts = [0]; for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { starts.push(i + 1); } }
        return offset => {
            let low = 0; let high = starts.length;
            while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) { low = mid; } else { high = mid; } }
            return new vscode.Position(low, Math.max(0, offset - starts[low]));
        };
    }
    private location(range: SourceRange): vscode.Location {
        return new vscode.Location(vscode.Uri.file(range.file), new vscode.Range(range.line, range.character, range.endLine, range.endCharacter));
    }
    private currentReferences(document: vscode.TextDocument, position: vscode.Position): CompilerReference[] {
        const project = this.project(document.fileName);
        if (!project.references.length) { return []; }
        // A disk watcher can arrive later than a navigation request; verify snapshots too.
        for (const [file, snapshot] of project.snapshots) {
            if (this.read(file) !== snapshot) { project.references = []; return []; }
        }
        return project.references.filter(reference => reference.locations.some(location => fileKey(location.file) === fileKey(document.fileName)
            && new vscode.Range(location.line, location.character, location.endLine, location.endCharacter).contains(position)
            && !(location.endLine === position.line && location.endCharacter === position.character)));
    }
    async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[]> {
        const file = this.file(document.fileName); if (!file) { return []; }
        const offset = document.offsetAt(position);
        const imported = file.imports.find(item => item.start <= offset && offset < item.end);
        if (imported) {
            const target = this.resolveImport(file, imported);
            return target ? [new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0))] : [];
        }
        const references = this.currentReferences(document, position);
        if (references.length) { return references.map(reference => this.location(reference.locations[0])); }
        return this.resolveAt(file, offset).map(item => this.symbolRange(item));
    }
    async provideTypeDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[]> {
        const file = this.file(document.fileName); if (!file) { return []; }
        const items = await this.semanticSymbols(document, position);
        return items.flatMap(item => {
            const type = this.inferredType(item);
            if (!type) { return []; }
            return this.resolveName(item.file, type, item.symbol.start).filter(other => ['struct', 'enum'].includes(other.symbol.kind)).map(other => this.symbolRange(other));
        });
    }
    private async semanticSymbols(document: vscode.TextDocument, position: vscode.Position): Promise<LocatedSymbol[]> {
        const file = this.file(document.fileName); if (!file) { return []; }
        const references = this.currentReferences(document, position); const result: LocatedSymbol[] = [];
        for (const reference of references) {
            const location = reference.locations[0]; const source = this.file(location.file); if (!source) { continue; }
            const point = this.positions(source.text);
            const symbol = source.symbols.find(item => point(item.start).isEqual(new vscode.Position(location.line, location.character)));
            if (symbol) { result.push({ file: source, symbol }); }
        }
        return result.length ? result : this.resolveAt(file, document.offsetAt(position));
    }
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        const symbols = await this.semanticSymbols(document, position); if (!symbols.length) { return undefined; }
        const markdown = new vscode.MarkdownString();
        for (const item of symbols.slice(0, 8)) {
            const symbol = item.symbol;
            markdown.appendCodeblock(symbol.signature || `${symbol.name} : ${symbol.type || this.inferredType(item) || symbol.kind}`, 'jai');
            if (symbol.documentation) { markdown.appendMarkdown(symbol.documentation + '\n\n'); }
        }
        return new vscode.Hover(markdown, document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/));
    }
    async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.SignatureHelp | undefined> {
        const file = this.file(document.fileName); if (!file) { return undefined; }
        const call = callAt(file, document.offsetAt(position)); if (!call) { return undefined; }
        const symbols = await this.semanticSymbols(document, document.positionAt(call.name.start));
        const help = new vscode.SignatureHelp();
        for (const item of symbols) {
            if (item.symbol.kind !== 'function') { continue; }
            const signature = new vscode.SignatureInformation(item.symbol.signature!, item.symbol.documentation);
            signature.parameters = (item.symbol.parameters || []).map(parameter => new vscode.ParameterInformation(parameter));
            help.signatures.push(signature);
        }
        if (!help.signatures.length) { return undefined; }
        help.activeSignature = Math.max(0, help.signatures.findIndex(signature => signature.parameters.length > call.argument));
        help.activeParameter = Math.min(call.argument, Math.max(0, help.signatures[help.activeSignature].parameters.length - 1));
        return help;
    }
    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
        const file = this.file(document.fileName); if (!file) { return []; }
        const offset = document.offsetAt(position);
        const string = file.tokens.find(token => token.kind === 'string' && token.start < offset && offset <= token.end);
        if (string) { return this.importCompletions(file, string.start, offset, document); }
        const before = file.text.slice(0, offset);
        const member = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_0-9]*)$/.exec(before);
        const symbols = member ? this.resolveName(file, member[1], offset).flatMap(item => this.members(item)) : this.visible(file, offset);
        const seen = new Set<string>(); const result: vscode.CompletionItem[] = [];
        for (const item of symbols) {
            const symbol = item.symbol; const label = symbol.signature || symbol.name;
            // Prefer the closest lexical binding; preserve overload signatures.
            const key = symbol.kind === 'function' ? label : symbol.name;
            if (seen.has(key)) { continue; } seen.add(key);
            const completion = new vscode.CompletionItem(symbol.name, completionKinds[symbol.kind]);
            completion.detail = symbol.signature || `${symbol.type || this.inferredType(item) || symbol.kind} — ${path.basename(item.file.path)}`;
            completion.documentation = new vscode.MarkdownString(symbol.documentation);
            completion.sortText = item.file === file ? '0' + symbol.name : '1' + symbol.name;
            result.push(completion);
        }
        if (!member) {
            for (const keyword of ['if', 'ifx', 'else', 'for', 'while', 'return', 'defer', 'using', 'struct', 'enum', 'enum_flags', 'interface', 'cast', 'true', 'false', 'null']) {
                if (!seen.has(keyword)) { result.push(new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword)); }
            }
            if (/#\w*$/.test(before)) {
                return ['import', 'load', 'Context', 'exists', 'discard', 'no_aoc', 'run', 'insert', 'code', 'expand', 'scope_file', 'scope_module', 'scope_export']
                    .map(name => new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword));
            }
        }
        return result;
    }
    private importCompletions(file: JaiFile, start: number, offset: number, document: vscode.TextDocument): vscode.CompletionItem[] {
        const before = file.text.slice(0, start); const directive = /#(import(?:,(?:file|dir))?|load)\s*$/.exec(before);
        if (!directive) { return []; }
        const prefix = file.text.slice(start + 1, offset).replace(/\\\\/g, '\\');
        const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
        const subpath = prefix.slice(0, slash + 1); const direct = ['load', 'import,file'].includes(directive[1]);
        const roots = direct ? [path.dirname(file.path)] : this.moduleDirs(file.path); const results = new Map<string, vscode.CompletionItem>();
        for (const root of roots) {
            try {
                for (const entry of fs.readdirSync(path.resolve(root, subpath), { withFileTypes: true })) {
                    if (!entry.isDirectory() && !entry.name.endsWith('.jai')) { continue; }
                    const label = entry.isDirectory() ? entry.name + '/' : direct ? entry.name : entry.name.slice(0, -4);
                    const completion = new vscode.CompletionItem(label, entry.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
                    completion.range = new vscode.Range(document.positionAt(start + 1 + slash + 1), document.positionAt(offset));
                    results.set(label, completion);
                }
            } catch { /* Incomplete path; other roots may still match. */ }
        }
        return [...results.values()];
    }
    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const file = this.file(document.fileName); if (!file) { return []; }
        const position = this.positions(file.text); const result: vscode.DocumentSymbol[] = [];
        const created = new Map<JaiSymbol, vscode.DocumentSymbol>();
        for (const symbol of file.symbols) {
            if (symbol.kind === 'parameter' || (symbol.scopeStart !== 0 && !symbol.owner)) { continue; }
            const value = new vscode.DocumentSymbol(symbol.name, symbol.type || '', symbolKinds[symbol.kind],
                new vscode.Range(position(symbol.start), position(symbol.end)), new vscode.Range(position(symbol.start), position(symbol.selectionEnd)));
            created.set(symbol, value);
            const parent = symbol.owner ? created.get(symbol.owner) : undefined;
            if (parent) { parent.children.push(value); } else { result.push(value); }
        }
        return result;
    }
    async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
        const uris = await vscode.workspace.findFiles('**/*.jai', '**/{.git,node_modules,.build,out}/**', 10000, token);
        const result: vscode.SymbolInformation[] = [];
        for (const uri of uris) {
            if (token.isCancellationRequested) { break; }
            const file = this.file(uri.fsPath); if (!file) { continue; }
            for (const symbol of file.symbols) {
                if (symbol.kind === 'parameter' || (symbol.scopeStart !== 0 && !symbol.owner) || !symbol.name.toLowerCase().includes(query.toLowerCase())) { continue; }
                result.push(new vscode.SymbolInformation(symbol.name, symbolKinds[symbol.kind], symbol.owner?.name || path.basename(file.path), this.symbolRange({ file, symbol })));
            }
        }
        return result;
    }
    async provideReferences(document: vscode.TextDocument, position: vscode.Position, options: { includeDeclaration: boolean }): Promise<vscode.Location[]> {
        const references = this.currentReferences(document, position);
        if (references.length) {
            return references.flatMap(reference => reference.locations.slice(options.includeDeclaration ? 0 : 1).map(range => this.location(range)));
        }
        const file = this.file(document.fileName); if (!file) { return []; }
        const binding = this.resolveAt(file, document.offsetAt(position)); if (binding.length !== 1) { return []; }
        const target = binding[0]; const result: vscode.Location[] = [];
        // Tolerant references are confined to a binding in its own source file.
        // Cross-file rename requires the compiler, avoiding guesses about aliases.
        if (target.file !== file || target.symbol.scopeStart === 0) { return options.includeDeclaration ? [this.symbolRange(target)] : []; }
        for (const token of file.tokens) {
            if (token.kind !== 'name' || token.text !== target.symbol.name) { continue; }
            const resolved = this.resolveAt(file, token.start);
            if (resolved.length === 1 && resolved[0].symbol === target.symbol && (options.includeDeclaration || token.start !== target.symbol.start)) {
                result.push(new vscode.Location(document.uri, new vscode.Range(document.positionAt(token.start), document.positionAt(token.end))));
            }
        }
        return result;
    }
    async prepareRename(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Range> {
        const file = this.file(document.fileName); const token = file ? tokenAt(file, document.offsetAt(position)) : undefined;
        if (!token || token.kind !== 'name' || !(await this.semanticSymbols(document, position)).length) { throw new Error('Select a Jai declaration or reference to rename.'); }
        if (token.text.includes('\\')) { throw new Error('Renaming escaped-space identifiers is not supported.'); }
        return new vscode.Range(document.positionAt(token.start), document.positionAt(token.end));
    }
    async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): Promise<vscode.WorkspaceEdit> {
        if (!/^[A-Za-z_]\w*$/.test(newName) || ['if', 'ifx', 'then', 'else', 'case', 'enum', 'true', 'false', 'null', 'cast', 'while', 'break', 'using', 'defer', 'union', 'return', 'struct', 'remove', 'inline', 'continue', 'operator', 'interface', 'enum_flags', 'context', 'push_context'].includes(newName)) {
            throw new Error('The new name must be a valid Jai identifier, not a keyword.');
        }
        await this.prepareRename(document, position);
        const file = this.file(document.fileName)!;
        const binding = await this.semanticSymbols(document, position);
        if (binding.length !== 1) { throw new Error('This position resolves to multiple declarations; rename an individual declaration.'); }
        const conflicts = this.visible(binding[0].file, binding[0].symbol.start).filter(item => item.symbol.name === newName && item.symbol !== binding[0].symbol);
        if (conflicts.length) { throw new Error('The new name is already used in this scope.'); }
        const compiled = this.currentReferences(document, position);
        const isLocal = binding[0].file === file && binding[0].symbol.scopeStart > 0;
        if (!compiled.length && !isLocal) { throw new Error('Save the project and let Jai finish compiling before renaming a global or member declaration.'); }
        const locations = await this.provideReferences(document, position, { includeDeclaration: true });
        const edit = new vscode.WorkspaceEdit(); const seen = new Set<string>();
        for (const location of locations) {
            if (/\.added_strings_\d+\.jai$/i.test(location.uri.fsPath)) { continue; }
            const source = this.read(location.uri.fsPath); if (source === undefined) { throw new Error('A referenced source file is unavailable.'); }
            const lines = source.split(/\r?\n/);
            if (location.range.start.line !== location.range.end.line || lines[location.range.start.line]?.slice(location.range.start.character, location.range.end.character) !== binding[0].symbol.name) {
                throw new Error('Reference locations changed; save and rebuild the project before renaming.');
            }
            const parsed = this.file(location.uri.fsPath)!;
            const lineOffset = source.split('\n').slice(0, location.range.start.line).reduce((sum, line) => sum + line.length + 1, 0);
            if (this.visible(parsed, lineOffset + location.range.start.character).some(item => item.symbol.name === newName && item.symbol !== binding[0].symbol)) {
                throw new Error('The new name would collide with or be shadowed by another declaration at a reference.');
            }
            const key = location.uri.toString() + ':' + location.range.start.line + ':' + location.range.start.character;
            if (!seen.has(key)) { edit.replace(location.uri, location.range, newName); seen.add(key); }
        }
        return edit;
    }
    private async compile(project: Project): Promise<void> {
        if (this.disposed) { return; }
        const generation = project.generation;
        const executable = this.compiler(project.root);
        if (!executable) { this.output.appendLine('Jai compiler not found. Set the-language.pathToJaiExecutable or add Jai to PATH.'); return; }
        const pluginDirectory = path.join(this.context.extensionPath, 'out');
        const plugin = fs.existsSync(path.join(pluginDirectory, 'VSCodeLocate.jai')) ? pluginDirectory : path.join(this.context.extensionPath, 'src');
        const args = ['-plug', 'VSCodeLocate', project.root, '-no_dce', '-Dump',
            ...splitArguments(this.config(project.root).get<string>('projectJaiArgs', '')), '--', 'import_dir', plugin];
        const process = new CompilerProcess(); project.process = process;
        if (this.config(project.root).get<boolean>('debugMode', false)) { this.output.appendLine(JSON.stringify([executable, ...args])); }
        // The compiler sees disk, so refuse to associate its data with dirty buffers.
        const before = new Map<string, string>();
        const capture = (file: JaiFile, seen = new Set<string>()) => {
            if (seen.has(fileKey(file.path))) { return; } seen.add(fileKey(file.path));
            try { before.set(fileKey(file.path), fs.readFileSync(file.path, 'utf8')); } catch { /* Missing entry will be diagnosed by Jai. */ }
            for (const dependency of this.dependencies(file)) { capture(dependency.file, seen); }
        };
        const entry = this.file(project.root); if (entry) { capture(entry); }
        const dirtyAtStart = [...before].some(([file, text]) => this.read(file) !== text);
        try {
            const result = await process.run(executable, args, path.dirname(project.root));
            if (generation !== project.generation || this.disposed) { return; }
            for (const uri of project.diagnostics) { this.diagnostics.delete(uri); } project.diagnostics = [];
            this.publishDiagnostics(project, result.stderr + '\n' + result.stdout.split(sentinel)[0]);
            if (result.code !== 0 || !result.stdout.includes(sentinel)) {
                this.output.appendLine(`Analysis of ${project.root} failed (exit ${result.code}).\n${result.stderr}\n${result.stdout.slice(0, 4096)}`); return;
            }
            const snapshots = new Map<string, string>();
            const references = parseReferences(result.stdout, file => {
                try { const text = fs.readFileSync(file, 'utf8'); snapshots.set(fileKey(file), text); return text; } catch { return undefined; }
            });
            // Include entry files without declarations so their edits invalidate data too.
            const visit = (file: JaiFile, seen = new Set<string>()) => {
                if (seen.has(fileKey(file.path))) { return; } seen.add(fileKey(file.path));
                try { snapshots.set(fileKey(file.path), fs.readFileSync(file.path, 'utf8')); } catch { /* Removed while compiling. */ }
                for (const dependency of this.dependencies(file)) { visit(dependency.file, seen); }
            };
            const root = this.file(project.root); if (root) { visit(root); }
            if (dirtyAtStart || [...before].some(([file, text]) => snapshots.get(file) !== text)
                || [...snapshots].some(([file, text]) => this.read(file) !== text)) { return; }
            project.snapshots = snapshots; project.references = references;
            this.output.appendLine(`Indexed ${references.length} declarations for ${path.basename(project.root)}.`);
        } catch (error) {
            if (generation === project.generation && !this.disposed) { this.output.appendLine(String(error)); }
        } finally {
            if (project.process === process) { project.process = undefined; }
        }
    }
    private publishDiagnostics(project: Project, output: string): void {
        const byFile = new Map<string, vscode.Diagnostic[]>();
        const pattern = /^(.+?):(\d+),(\d+):\s+(Error|Warning):\s+([^\r\n]*)/gm;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(output))) {
            const file = path.resolve(path.dirname(project.root), match[1].trim());
            const line = Number(match[2]) - 1; const lines = (this.read(file) || '').split(/\r?\n/);
            const character = byteColumnToCharacter(lines[line] || '', Number(match[3]) - 1);
            const diagnostic = new vscode.Diagnostic(new vscode.Range(line, character, line, character + 1), match[5], match[4] === 'Error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
            diagnostic.source = 'Jai';
            const diagnostics = byFile.get(file) || []; diagnostics.push(diagnostic); byFile.set(file, diagnostics);
        }
        for (const [file, diagnostics] of byFile) {
            const uri = vscode.Uri.file(file); this.diagnostics.set(uri, diagnostics); project.diagnostics.push(uri);
        }
    }
}
