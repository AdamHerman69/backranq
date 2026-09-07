import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve('artifacts/practice-v4-runtime');
fs.mkdirSync(root, { recursive: true });
const temp = fs.mkdtempSync(path.join(root, 'run-'));
try {
    const outfile = path.join(temp, 'audit.mjs');
    await build({ entryPoints: ['scripts/practice-v4-audit.ts'], outfile, bundle: true, packages: 'external',
        platform: 'node', format: 'esm', target: 'node24', tsconfig: 'tsconfig.json' });
    await (await import(pathToFileURL(outfile).href)).main(process.argv.slice(2));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
