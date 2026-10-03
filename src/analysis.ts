// A tolerant source index for editing incomplete or unsaved code. Compiler
// references remain authoritative when all source snapshots match the disk.
export interface Token { text: string; start: number; end: number; kind: 'name' | 'string' | 'symbol'; }
export interface JaiImport { name: string; kind: string; start: number; end: number; alias?: string; }
export interface JaiSymbol {
    name: string; kind: 'function' | 'struct' | 'enum' | 'variable' | 'constant' | 'module' | 'parameter';
    start: number; end: number; selectionEnd: number; scopeStart: number; scopeEnd: number;
    type?: string; initializer?: string; signature?: string; parameters?: string[];
    documentation: string; visibility: 'export' | 'module' | 'file'; owner?: JaiSymbol;
    using: boolean;
}
export interface JaiFile { path: string; text: string; tokens: Token[]; symbols: JaiSymbol[]; imports: JaiImport[]; }

export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < text.length) {
        if (/\s/.test(text[i])) { i++; continue; }
        if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
        if (text.startsWith('/*', i)) {
            i += 2; let depth = 1;
            while (i < text.length && depth) {
                if (text.startsWith('/*', i)) { depth++; i += 2; }
                else if (text.startsWith('*/', i)) { depth--; i += 2; }
                else { i++; }
            }
            continue;
        }
        const start = i;
        if (text[i] === '"') {
            i++;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; }
                else if (text[i++] === '"') { break; }
            }
            tokens.push({ text: text.slice(start, i), start, end: i, kind: 'string' });
        } else if (/[A-Za-z_]/.test(text[i])) {
            i++;
            while (i < text.length && /[A-Za-z_0-9]/.test(text[i])) { i++; }
            while (text[i] === '\\' && /[ \t]/.test(text[i + 1] || '')) {
                i++;
                while (/[ \t]/.test(text[i] || '')) { i++; }
                while (/[A-Za-z_0-9]/.test(text[i] || '')) { i++; }
            }
            const name = text.slice(start, i);
            // Jai here strings are opaque, including any apparent declarations.
            if (name === 'string' && tokens.length && tokens[tokens.length - 1].text === '#') {
                tokens.push({ text: name, start, end: i, kind: 'name' });
                const header = /^[ \t]+([A-Za-z_0-9]+)[ \t]*\r?\n/.exec(text.slice(i));
                if (header) {
                    const bodyStart = i;
                    i += header[0].length;
                    const closing = new RegExp('^[ \\t]*' + header[1] + '(?=[ \\t]*(?:;|\\r?$))', 'm').exec(text.slice(i));
                    i = closing ? i + closing.index + closing[0].length : text.length;
                    tokens.push({ text: text.slice(bodyStart, i), start: bodyStart, end: i, kind: 'string' });
                }
            } else { tokens.push({ text: name, start, end: i, kind: 'name' }); }
        } else {
            const op = ['::', ':=', '->', '=>', '..', ',,', '.*'].find(value => text.startsWith(value, i));
            i += op ? op.length : 1;
            tokens.push({ text: text.slice(start, i), start, end: i, kind: 'symbol' });
        }
    }
    return tokens;
}

function docBefore(text: string, start: number): string {
    const before = text.slice(0, start).replace(/[ \t]*$/, '');
    const block = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*$/.exec(before);
    if (block) { return block[1].split(/\r?\n/).map(line => line.replace(/^\s*\* ?/, '').trimEnd()).join('\n').trim(); }
    const lines = before.split(/\r?\n/); const docs: string[] = [];
    if (!lines[lines.length - 1].trim()) { lines.pop(); }
    while (lines.length && /^\s*\/\//.test(lines[lines.length - 1])) {
        docs.unshift(lines.pop()!.replace(/^\s*\/\/\/?\s?/, ''));
    }
    return docs.join('\n');
}

export function parseFile(filePath: string, text: string): JaiFile {
    const tokens = tokenize(text);
    const pairs = new Map<number, number>(); const stack: number[] = [];
    const parentBlock = new Map<number, number>(); const blocks: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        parentBlock.set(i, blocks.length ? blocks[blocks.length - 1] : -1);
        if (['(', '[', '{'].includes(tokens[i].text)) {
            stack.push(i);
            if (tokens[i].text === '{') { blocks.push(i); }
        } else if ([')', ']', '}'].includes(tokens[i].text)) {
            const opener = { ')': '(', ']': '[', '}': '{' }[tokens[i].text];
            if (stack.length && tokens[stack[stack.length - 1]].text === opener) {
                pairs.set(stack.pop()!, i);
            }
            if (tokens[i].text === '}') { blocks.pop(); }
        }
    }
    const imports: JaiImport[] = [];
    for (let i = 0; i < tokens.length - 2; i++) {
        if (tokens[i].text !== '#' || !['import', 'load'].includes(tokens[i + 1].text)) { continue; }
        let cursor = i + 2; let kind = tokens[i + 1].text;
        if (tokens[cursor]?.text === ',') { kind += ',' + tokens[cursor + 1]?.text; cursor += 2; }
        const token = tokens[cursor];
        if (token?.kind !== 'string' || !token.text.startsWith('"') || !token.text.endsWith('"')) { continue; }
        // Decode only filename escapes, never evaluate code or unknown escapes.
        const name = token.text.slice(1, -1).replace(/\\([\\"])/g, '$1');
        imports.push({ name, kind, start: token.start, end: token.end,
            alias: tokens[i - 1]?.text === '::' ? tokens[i - 2]?.text : undefined });
    }
    const symbols: JaiSymbol[] = []; const bodyOwners = new Map<number, JaiSymbol>();
    let visibility: JaiSymbol['visibility'] = 'export';
    for (let i = 0; i < tokens.length - 1; i++) {
        const token = tokens[i]; const op = tokens[i + 1].text;
        if (tokens[i - 1]?.text === '#' && /^scope_(file|module|export)$/.test(token.text)) {
            visibility = token.text.slice(6) as JaiSymbol['visibility'];
        }
        if (token.kind !== 'name' || ![':', '::', ':='].includes(op) || tokens[i - 1]?.text === '.') { continue; }
        let cursor = i + 2;
        if (['inline', 'no_inline'].includes(tokens[cursor]?.text)) { cursor++; }
        const rhs = tokens[cursor]?.text;
        let kind: JaiSymbol['kind'] = op === '::' ? 'constant' : 'variable';
        let body = -1; let endToken = cursor;
        let signature: string | undefined; let parameters: string[] | undefined; let type: string | undefined;
        if (op === '::' && rhs === '(' && pairs.has(cursor)) {
            kind = 'function';
            const close = pairs.get(cursor)!;
            const segments: string[] = []; let segment = cursor + 1;
            for (let p = segment; p < close; p++) {
                if (pairs.has(p)) { p = pairs.get(p)!; continue; }
                if (tokens[p].text === ',') {
                    if (segment < p) { segments.push(text.slice(tokens[segment].start, tokens[p].start).trim()); }
                    segment = p + 1;
                }
            }
            if (segment < close) { segments.push(text.slice(tokens[segment].start, tokens[close].start).trim()); }
            parameters = segments;
            endToken = close;
            let p = close + 1;
            if (tokens[p]?.text === '->') {
                const first = p + 1; p++;
                while (p < tokens.length && !['{', ';', '#', '::'].includes(tokens[p].text)) {
                    if (pairs.has(p)) { p = pairs.get(p)!; }
                    endToken = p++;
                }
                type = text.slice(tokens[first]?.start || tokens[close].end, tokens[endToken]?.end).trim();
            }
            signature = text.slice(token.start, tokens[endToken]?.end || token.end).trim();
            // Procedure directives may occur between its header and body.
            while (p < tokens.length && !['{', ';', '::'].includes(tokens[p].text)) { p++; }
            if (tokens[p]?.text === '{') { body = p; }
        } else if (op === '::' && ['struct', 'enum', 'enum_flags'].includes(rhs)) {
            kind = rhs === 'struct' ? 'struct' : 'enum';
            let p = cursor + 1;
            if (tokens[p]?.text === '(' && pairs.has(p)) { p = pairs.get(p)! + 1; }
            while (p < tokens.length && !['{', ';', '::'].includes(tokens[p].text)) { p++; }
            if (tokens[p]?.text === '{') { body = p; }
            endToken = body >= 0 ? body : cursor;
        } else if (rhs === '#' && tokens[cursor + 1]?.text === 'import') {
            kind = 'module'; endToken = cursor + 2;
        } else {
            while (endToken < tokens.length && ![';', ',', ')', '}'].includes(tokens[endToken].text)) {
                if (tokens[endToken].text === '{' && !pairs.has(endToken)) { break; }
                if (pairs.has(endToken)) { endToken = pairs.get(endToken)!; }
                endToken++;
            }
            endToken = Math.max(cursor, endToken - 1);
            if (op === ':') {
                let p = cursor;
                while (p <= endToken && !['=', ':', '#'].includes(tokens[p].text)) { p++; }
                type = p > cursor ? text.slice(tokens[cursor].start, tokens[p - 1].end).trim() : undefined;
            }
        }
        const parent = parentBlock.get(i)!;
        const owner = bodyOwners.get(parent);
        const scopeStart = parent < 0 ? 0 : tokens[parent].start;
        const scopeEnd = parent < 0 ? text.length : tokens[pairs.get(parent)!]?.end || text.length;
        const initializer = text.slice(tokens[i + 1].end, tokens[endToken]?.end || token.end).trim();
        const symbol: JaiSymbol = { name: token.text, kind, start: token.start,
            end: body < 0 ? tokens[endToken]?.end || token.end : tokens[pairs.get(body)!]?.end || text.length,
            selectionEnd: token.end, scopeStart, scopeEnd, type, initializer, signature, parameters,
            documentation: docBefore(text, token.start), visibility, owner, using: tokens[i - 1]?.text === 'using' };
        symbols.push(symbol);
        if (body >= 0) { bodyOwners.set(body, symbol); }
        // Function arguments are visible throughout the header and body.
        if (kind === 'function') {
            const close = pairs.get(cursor)!;
            for (let p = cursor + 1; p < close; p++) {
                if (tokens[p].kind !== 'name' || ![':', ':=', '::'].includes(tokens[p + 1]?.text)) { continue; }
                let last = p + 2;
                while (last < close && tokens[last].text !== ',') {
                    if (pairs.has(last)) { last = pairs.get(last)!; }
                    last++;
                }
                symbols.push({ name: tokens[p].text, kind: 'parameter', start: tokens[p].start, selectionEnd: tokens[p].end,
                    end: tokens[Math.max(p, last - 1)].end, scopeStart: token.start, scopeEnd: symbol.end,
                    type: text.slice(tokens[p + 1].end, tokens[Math.max(p + 1, last - 1)].end).trim().split(/\s*=\s*/)[0],
                    documentation: '', visibility: 'file', owner: symbol, using: false });
            }
            i = close;
        }
    }
    // Enum entries without a colon are declarations too.
    for (const [body, owner] of bodyOwners) {
        if (owner.kind !== 'enum') { continue; }
        const close = pairs.get(body) || tokens.length;
        for (let p = body + 1; p < close; p++) {
            const token = tokens[p];
            if (parentBlock.get(p) !== body || token.kind !== 'name' || !['{', ';', ','].includes(tokens[p - 1]?.text)) { continue; }
            if (symbols.some(symbol => symbol.start === token.start)) { continue; }
            symbols.push({ name: token.text, kind: 'constant', start: token.start, selectionEnd: token.end, end: token.end,
                scopeStart: tokens[body].start, scopeEnd: owner.end, type: owner.name, documentation: docBefore(text, token.start),
                visibility: owner.visibility, owner, using: false });
        }
    }
    return { path: filePath, text, tokens, symbols, imports };
}

export function tokenAt(file: JaiFile, offset: number): Token | undefined {
    return file.tokens.find(token => token.start <= offset && offset < token.end);
}

export function callAt(file: JaiFile, offset: number): { name: Token; argument: number } | undefined {
    const stack: { index: number; argument: number }[] = [];
    for (let i = 0; i < file.tokens.length && file.tokens[i].start < offset; i++) {
        const token = file.tokens[i];
        if (['(', '[', '{'].includes(token.text)) { stack.push({ index: i, argument: 0 }); }
        else if ([')', ']', '}'].includes(token.text)) { stack.pop(); }
        else if (token.text === ',' && stack.length && stack[stack.length - 1].argument >= 0) { stack[stack.length - 1].argument++; }
        else if (token.text === ',,' && stack.length) { stack[stack.length - 1].argument = -1; }
    }
    for (let i = stack.length - 1; i >= 0; i--) {
        const frame = stack[i]; const name = file.tokens[frame.index - 1];
        if (file.tokens[frame.index].text === '(' && name?.kind === 'name' && frame.argument >= 0) { return { name, argument: frame.argument }; }
    }
    return undefined;
}

export function splitArguments(value: string): string[] {
    const args: string[] = []; let current = ''; let quoted = false;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '"') { quoted = !quoted; }
        else if (!quoted && /\s/.test(value[i])) { if (current) { args.push(current); current = ''; } }
        else { current += value[i]; }
    }
    if (current) { args.push(current); }
    return args;
}

export function byteColumnToCharacter(line: string, column: number): number {
    let bytes = 0; let character = 0;
    for (const point of line) {
        const size = Buffer.byteLength(point, 'utf8');
        if (bytes + size > column) { break; }
        bytes += size; character += point.length;
    }
    return character;
}
