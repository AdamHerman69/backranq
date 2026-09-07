import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** No automatic pin updates: a changed upstream build needs an explicit review. */
export function verifyStockfishArtifact({ binDir, artifact, workerPath }) {
    if (!/^[0-9a-f]{64}$/.test(artifact.jsSha256) || !/^[0-9a-f]{64}$/.test(artifact.wasmSha256)) {
        throw new Error('Invalid Stockfish artifact digest pins');
    }
    for (const [file, expected] of [
        ['stockfish-18-lite-single.js', artifact.jsSha256],
        ['stockfish-18-lite-single.wasm', artifact.wasmSha256],
    ]) {
        if (digest(fs.readFileSync(path.join(binDir, file))) !== expected) {
            throw new Error(`Stockfish artifact digest mismatch: ${file}`);
        }
    }
    const artifactId = `stockfish-js-wasm-sha256:${artifact.jsSha256}:${artifact.wasmSha256}`;
    if (workerPath) {
        const worker = fs.readFileSync(workerPath, 'utf8');
        const declared = /artifactId:\s*'([^']+)'/.exec(worker)?.[1];
        if (declared !== artifactId) throw new Error('Stockfish bridge artifact identity differs from verified runtime');
    }
    return artifactId;
}

export function copyStockfishBrowser(root = process.cwd()) {
    const pkgDir = path.dirname(require.resolve('stockfish/package.json'));
    const binDir = path.join(pkgDir, 'bin');
    const outDir = path.join(root, 'public/vendor/stockfish');
    const artifact = JSON.parse(fs.readFileSync(path.join(root, 'src/lib/analysis/stockfishArtifact.json'), 'utf8'));
    const workerPath = path.join(outDir, 'backranq-engine.worker.js');
    // Verify before writing anything, then verify the actual served copies too.
    verifyStockfishArtifact({ binDir, artifact, workerPath });
    fs.mkdirSync(outDir, { recursive: true });
    for (const file of ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm']) {
        fs.copyFileSync(path.join(binDir, file), path.join(outDir, file));
    }
    fs.copyFileSync(path.join(pkgDir, 'Copying.txt'), path.join(outDir, 'COPYING.txt'));
    verifyStockfishArtifact({ binDir: outDir, artifact, workerPath });
    console.log('[copy-stockfish-browser] Verified and copied pinned Stockfish JS/WASM assets and GPL license.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) copyStockfishBrowser();
