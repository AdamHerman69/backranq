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

const pkgJsonPath = require.resolve('stockfish/package.json');
const pkgDir = path.dirname(pkgJsonPath);
const binDir = path.join(pkgDir, 'bin');

const outDir = path.resolve(process.cwd(), 'public/vendor/stockfish');
ensureDir(outDir);

const files = [
    {
        from: path.join(binDir, 'stockfish-18-lite-single.js'),
        to: path.join(outDir, 'stockfish-18-lite-single.js'),
    },
    {
        from: path.join(binDir, 'stockfish-18-lite-single.wasm'),
        to: path.join(outDir, 'stockfish-18-lite-single.wasm'),
    },
    {
        from: path.join(pkgDir, 'Copying.txt'),
        to: path.join(outDir, 'COPYING.txt'),
    },
];
let copied = 0;
for (const file of files) {
    if (copyIfExists(file.from, file.to)) copied++;
}

if (copied !== files.length) {
    console.error(
        `[copy-stockfish-browser] Copied ${copied}/${
            files.length
        } files. Expected the Stockfish 18 lite-single runtime and GPL license from ${pkgDir}`
    );
    process.exitCode = 1;
} else {
    console.log(
        `[copy-stockfish-browser] Copied Stockfish 18 lite-single assets to ${outDir}`
    );
}
