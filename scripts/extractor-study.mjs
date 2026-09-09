import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

// Build a self-contained runner, but only its explicit subcommand starts work.
// Do not import the old live-ablation script: it starts engines at module load.
const built = await build({ entryPoints: ['scripts/extractor-study/entry.ts'], bundle: true,
    packages: 'external', platform: 'node', format: 'esm', target: 'node24',
    tsconfig: 'tsconfig.json', write: false, sourcemap: false, legalComments: 'none' });
const { createHash } = await import('node:crypto');
const bytes = built.outputFiles[0].contents;
const digest = createHash('sha256').update(bytes).digest('hex');
const directory = path.resolve('artifacts/extractor-study-runtime');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, `${digest}.mjs`);
if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx' });
const child = spawn(process.execPath, [file, ...process.argv.slice(2)], { stdio: 'inherit' });
const stop = () => child.kill('SIGTERM');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.exitCode = code ?? (signal ? 130 : 1);
});
