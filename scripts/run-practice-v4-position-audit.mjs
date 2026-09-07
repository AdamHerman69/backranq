import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const root = path.resolve('artifacts/practice-v4-runtime');
fs.mkdirSync(root, { recursive: true });
const temp = fs.mkdtempSync(path.join(root, 'run-'));
try {
    const outfile = path.join(temp, 'audit.mjs');
    await build({ entryPoints: ['scripts/practice-v4-position-audit.ts'], outfile, bundle: true, packages: 'external',
        platform: 'node', format: 'esm', target: 'node24', tsconfig: 'tsconfig.json' });
    if (process.argv[2] === 'build') console.log(JSON.stringify({ built: true, bytes: fs.statSync(outfile).size }));
    else await (await import(pathToFileURL(outfile).href)).main(process.argv.slice(2));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
