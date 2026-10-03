import * as assert from 'assert';
import { parseFile, tokenize, callAt, byteColumnToCharacter, splitArguments } from '../../analysis';
import { parseReferences, sentinel, CompilerProcess, resolveCompiler } from '../../compiler';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

suite('Jai source index', () => {
    test('Ignores nested comments, quoted strings, and Jai here strings', () => {
        const source = '// bad :: () {}\n/* outer /* fake: int; */ done */\ntext :: #string END\nfalse_symbol :: () {}\nEND\nreal :: () {}';
        assert.deepStrictEqual(parseFile('test.jai', source).symbols.map(symbol => symbol.name), ['text', 'real']);
        assert.strictEqual(tokenize('"#load \\"bad.jai\\""').length, 1);
    });
    test('Indexes multiline procedures, arguments, members and enum entries', () => {
        const source = '/** Makes a value. */\nmake :: (\n x: int,\n y: int = 2\n) -> Box { return Box.{x}; }\nBox :: struct { value: int; }\nMode :: enum { FIRST; SECOND; }';
        const file = parseFile('test.jai', source);
        const make = file.symbols.find(symbol => symbol.name === 'make')!;
        assert.strictEqual(make.kind, 'function'); assert.strictEqual(make.type, 'Box');
        assert.deepStrictEqual(make.parameters, ['x: int', 'y: int = 2']);
        assert.strictEqual(make.documentation, 'Makes a value.');
        assert.strictEqual(file.symbols.find(symbol => symbol.name === 'x')!.owner, make);
        assert.strictEqual(file.symbols.find(symbol => symbol.name === 'value')!.owner!.name, 'Box');
        assert.deepStrictEqual(file.symbols.filter(symbol => symbol.owner?.name === 'Mode').map(symbol => symbol.name), ['FIRST', 'SECOND']);
    });
    test('Preserves declaration scope and module import aliases', () => {
        const file = parseFile('test.jai', '#scope_file\nM :: #import "Math";\n#load "other.jai";\nmain :: () { x := 1; { x := 2; } }');
        assert.strictEqual(file.imports[0].alias, 'M');
        assert.strictEqual(file.imports[1].kind, 'load');
        assert.strictEqual(file.symbols[0].visibility, 'file');
        const xs = file.symbols.filter(symbol => symbol.name === 'x');
        assert.strictEqual(xs.length, 2); assert.notStrictEqual(xs[0].scopeStart, xs[1].scopeStart);
    });
    test('Counts arguments with nested calls, composites and context overrides', () => {
        const source = 'outer(inner(1, 2), Box.{1, 2}, '; const file = parseFile('test.jai', source);
        assert.strictEqual(callAt(file, source.length)!.name.text, 'outer');
        assert.strictEqual(callAt(file, source.length)!.argument, 2);
        assert.strictEqual(callAt(parseFile('test.jai', 'f(1,, allocator='), 16), undefined);
    });
    test('Converts UTF-8 byte columns into VS Code UTF-16 columns', () => {
        assert.strictEqual(byteColumnToCharacter('中文😀name', 10), 4);
        assert.strictEqual(byteColumnToCharacter('中文😀name', 12), 6);
        assert.deepStrictEqual(splitArguments('-import_dir "D:\\some modules" -release'), ['-import_dir', 'D:\\some modules', '-release']);
    });
    test('Decodes the compiler protocol and deduplicates repeated locations', () => {
        const filename = path.resolve('probe.jai'); const row = `name|${filename}|1|11|1|15`;
        const references = parseReferences(`noise\n${sentinel}${row}\n|${filename}|1|11|1|15\n\nnot protocol`, () => '中文😀name');
        assert.strictEqual(references.length, 1); assert.strictEqual(references[0].locations.length, 1);
        assert.strictEqual(references[0].locations[0].character, 4);
        assert.strictEqual(references[0].locations[0].endCharacter, 8);
    });
});

suite('Jai compiler compatibility', () => {
    test('Reports launch errors without leaving a pending request', async () => {
        await assert.rejects(new CompilerProcess().run('not-a-jai-compiler-583920', [], os.tmpdir()));
    });
    test('Jai 0.2.009 compiles the bundled navigation plugin', async function () {
        this.timeout(60000);
        const executable = resolveCompiler(process.env.JAI_TEST_COMPILER || 'jai');
        if (!executable) { this.skip(); return; }
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jai-navigation-test-'));
        try {
            const file = path.join(directory, 'main.jai');
            fs.writeFileSync(file, '#import "Basic";\nhelper :: (value: int) -> int { return value + 1; }\nmain :: () { print("%\\n", helper(41)); identity(1); identity(1.5); }\nidentity :: (value: $T) -> T { return value; }\n');
            const pluginDirectory = path.resolve(__dirname, '../..');
            const result = await new CompilerProcess().run(executable, ['-plug', 'VSCodeLocate', file, '-no_dce', '-Dump', '--', 'import_dir', pluginDirectory], directory);
            assert.strictEqual(result.code, 0, result.stderr + result.stdout.slice(0, 1000));
            assert.ok(result.stdout.includes(sentinel), 'Compiler produced no reference protocol');
            const references = parseReferences(result.stdout, name => { try { return fs.readFileSync(name, 'utf8'); } catch { return undefined; } });
            assert.ok(references.some(reference => reference.name === 'helper' && reference.locations.some(location => location.line === 2)));
            assert.ok(references.some(reference => reference.name === 'print' && reference.locations.some(location => location.file === file)));
            const polymorphic = references.filter(reference => reference.name === 'identity' && reference.locations[0].file === file);
            assert.strictEqual(polymorphic.length, 1, 'Polymorphic instances must merge at the original declaration');
            assert.strictEqual(polymorphic[0].locations.length, 3);
        } finally {
            // Remove only this test's freshly-created temporary directory.
            fs.rmdirSync(directory, { recursive: true });
        }
    });
});
