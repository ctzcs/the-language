import * as fs from 'fs';
import * as path from 'path';
import * as proc from 'child_process';
import { byteColumnToCharacter } from './analysis';

export const sentinel = 'fe955110-fc9e-4c28-be65-93cdffdb26c9';
export interface SourceRange { file: string; line: number; character: number; endLine: number; endCharacter: number; }
export interface CompilerReference { name: string; locations: SourceRange[]; }
export interface CompilerResult { stdout: string; stderr: string; code: number; }

export function fileKey(file: string): string {
    const normalized = path.resolve(file);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function resolveCompiler(configured: string): string | undefined {
    const names = process.platform === 'win32' ? ['jai.exe'] : ['jai', 'jai-linux', 'jai-macos'];
    if (configured && (path.isAbsolute(configured) || configured.includes(path.sep))) {
        return fs.existsSync(configured) ? path.resolve(configured) : undefined;
    }
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        for (const name of configured && !['jai', 'jai.exe'].includes(configured) ? [configured] : names) {
            const candidate = path.join(directory, name);
            if (fs.existsSync(candidate)) { return candidate; }
        }
    }
    const fallback = process.platform === 'win32' ? 'c:/jai/bin/jai.exe' : '';
    return fallback && fs.existsSync(fallback) ? fallback : undefined;
}

export function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

export function parseReferences(stdout: string, read: (file: string) => string | undefined): CompilerReference[] {
    const marker = stdout.indexOf(sentinel);
    if (marker < 0) { return []; }
    const result: CompilerReference[] = []; let current: CompilerReference | undefined;
    const texts = new Map<string, string[]>();
    for (const row of stripAnsi(stdout.slice(marker + sentinel.length)).split(/\r?\n/)) {
        const fields = row.split('|');
        if (fields.length !== 6 || !fields.slice(2).every(field => /^\d+$/.test(field))) { continue; }
        if (fields[0]) { current = { name: fields[0], locations: [] }; result.push(current); }
        if (!current) { continue; }
        const file = path.resolve(fields[1]);
        if (!texts.has(file)) { texts.set(file, (read(file) || '').split(/\r?\n/)); }
        const lines = texts.get(file)!;
        const line = Number(fields[2]) - 1; const endLine = Number(fields[4]) - 1;
        const location = { file, line, endLine,
            character: byteColumnToCharacter(lines[line] || '', Number(fields[3]) - 1),
            endCharacter: byteColumnToCharacter(lines[endLine] || '', Number(fields[5]) - 1) };
        if (line < 0 || endLine < line || (line === endLine && location.endCharacter < location.character)) { continue; }
        if (!current.locations.some(other => JSON.stringify(other) === JSON.stringify(location))) { current.locations.push(location); }
    }
    // Polymorphic instantiations can expose separate declaration pointers with
    // the same original source location. They still represent one rename target.
    const declarations = new Map<string, CompilerReference>();
    for (const reference of result.filter(item => item.locations.length > 0)) {
        const declaration = reference.locations[0];
        const key = reference.name + ':' + fileKey(declaration.file) + ':' + declaration.line + ':' + declaration.character;
        const existing = declarations.get(key);
        if (!existing) { declarations.set(key, reference); continue; }
        for (const location of reference.locations) {
            if (!existing.locations.some(other => JSON.stringify(other) === JSON.stringify(location))) { existing.locations.push(location); }
        }
    }
    return [...declarations.values()];
}

export class CompilerProcess {
    private child?: proc.ChildProcess;
    private stopped = false;
    cancel(): void {
        this.stopped = true;
        if (this.child) { this.child.kill(); }
    }
    run(executable: string, args: string[], cwd: string): Promise<CompilerResult> {
        return new Promise((resolve, reject) => {
            if (this.stopped) { reject(new Error('Compilation cancelled')); return; }
            const child = proc.spawn(executable, args, { cwd, windowsHide: true });
            this.child = child;
            const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let settled = false;
            const finish = (error?: Error, code = 0) => {
                if (settled) { return; }
                settled = true; clearTimeout(timer); this.child = undefined;
                if (error) { reject(error); }
                else { resolve({ stdout: stripAnsi(Buffer.concat(stdout).toString()), stderr: stripAnsi(Buffer.concat(stderr).toString()), code }); }
            };
            const timer = setTimeout(() => { finish(new Error('Jai analysis exceeded 60 seconds')); child.kill(); }, 60000);
            const collect = (buffers: Buffer[], chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 64 * 1024 * 1024) { finish(new Error('Jai analysis output exceeded 64 MiB')); child.kill(); }
                else { buffers.push(chunk); }
            };
            child.stdout!.on('data', chunk => collect(stdout, chunk));
            child.stderr!.on('data', chunk => collect(stderr, chunk));
            child.on('error', error => finish(error));
            // close, unlike exit, waits for the final stdout/stderr chunks.
            child.on('close', code => finish(this.stopped ? new Error('Compilation cancelled') : undefined, code === null ? -1 : code));
        });
    }
}
