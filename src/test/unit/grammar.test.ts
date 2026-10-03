import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Use the same TextMate/Oniguruma engines as VS Code, rather than checking that
// a keyword merely appears somewhere in the grammar's JSON source.
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

suite('Jai 0.2 syntax highlighting', () => {
    let grammar: { tokenizeLine(text: string): { tokens: { startIndex: number; endIndex: number; scopes: string[] }[] } };
    suiteSetup(async () => {
        await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
        const registry = new textmate.Registry({
            onigLib: Promise.resolve({ createOnigScanner: oniguruma.createOnigScanner, createOnigString: oniguruma.createOnigString }),
            loadGrammar: async (scope: string) => scope === 'source.jai' ? textmate.parseRawGrammar(
                fs.readFileSync(path.resolve(__dirname, '../../../syntaxes/jai.json'), 'utf8'), 'jai.json') : null
        });
        grammar = await registry.loadGrammar('source.jai');
    });
    function scopesAt(source: string, needle: string): string[] {
        const offset = source.indexOf(needle);
        const token = grammar.tokenizeLine(source).tokens.find(item => item.startIndex <= offset && offset < item.endIndex);
        assert.ok(token, `No token for ${needle}`); return token!.scopes;
    }
    test('Recognizes new directives and interface restrictions', () => {
        for (const directive of ['#Context', '#exists', '#discard', '#no_aoc']) {
            assert.ok(scopesAt(directive + ' foo;', directive).includes('keyword.other.directive.jai'), directive);
        }
        assert.ok(scopesAt('interface Box', 'interface').includes('keyword.declaration.interface.jai'));
    });
    test('Recognizes function-style casts, postfix dereference and context overrides', () => {
        assert.ok(scopesAt('x = cast,trunc(s32, value);', 'cast').includes('keyword.control.cast.jai'));
        assert.ok(scopesAt('value = pointer.*;', '.*').includes('keyword.operator.pointer.jai'));
        assert.ok(scopesAt('f(1,, allocator=temp);', ',,').includes('keyword.operator.context.jai'));
    });
});
