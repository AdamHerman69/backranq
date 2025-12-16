import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

function copyIfExists(from, to) {
    if (!fs.existsSync(from)) return false;
    fs.copyFileSync(from, to);
    return true;
}

const pkgJsonPath = require.resolve('stockfish.wasm/package.json');
const pkgDir = path.dirname(pkgJsonPath);

const outDir = path.resolve(process.cwd(), 'public/vendor/stockfish');
ensureDir(outDir);

const files = ['stockfish.js', 'stockfish.wasm', 'stockfish.worker.js'];
let copied = 0;
for (const f of files) {
    const from = path.join(pkgDir, f);
    const to = path.join(outDir, f);
    if (copyIfExists(from, to)) copied++;
}

if (copied !== files.length) {
    console.warn(
        `[copy-stockfish-wasm] Copied ${copied}/${
            files.length
        } files. Expected ${files.join(', ')} from ${pkgDir}`
    );
    process.exitCode = 0;
} else {
    console.log(`[copy-stockfish-wasm] Copied ${copied} files to ${outDir}`);
}
