const fs = require('fs');
const path = require('path');
const child = require('child_process');

const root = path.resolve(__dirname, '..');
const tsc = require.resolve('typescript/bin/tsc');
const result = child.spawnSync(process.execPath, [tsc, '-p', root], { stdio: 'inherit' });
if (result.status !== 0) { process.exit(result.status || 1); }
for (const name of ['VSCodeLocate.jai', 'asmCommands.json']) {
    fs.copyFileSync(path.join(root, 'src', name), path.join(root, 'out', name));
}
