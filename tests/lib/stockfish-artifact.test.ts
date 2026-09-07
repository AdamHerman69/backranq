import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { verifyStockfishArtifact } from '../../scripts/copy-stockfish-browser.mjs';
import artifact from '@/lib/analysis/stockfishArtifact.json';
import { STOCKFISH_ARTIFACT_ID } from '@/lib/analysis/stockfishMetadata';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

it('identifies the installed server runtime and served browser runtime by the same verified bytes', () => {
    const require = createRequire(import.meta.url);
    const packageDir = dirname(require.resolve('stockfish/package.json'));
    const workerPath = join(process.cwd(), 'public/vendor/stockfish/backranq-engine.worker.js');
    for (const binDir of [join(packageDir, 'bin'), join(process.cwd(), 'public/vendor/stockfish')]) {
        expect(verifyStockfishArtifact({ binDir, artifact, workerPath })).toBe(STOCKFISH_ARTIFACT_ID);
    }
});

it.each(['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm'])('rejects changed %s bytes even when version/name and declared bridge identity are unchanged', file => {
    const binDir = mkdtempSync(join(tmpdir(), 'backranq-artifact-')); folders.push(binDir);
    const js = Buffer.from('reviewed-js'); const wasm = Buffer.from('reviewed-wasm');
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const pins = { jsSha256: hash(js), wasmSha256: hash(wasm) };
    writeFileSync(join(binDir, 'stockfish-18-lite-single.js'), js);
    writeFileSync(join(binDir, 'stockfish-18-lite-single.wasm'), wasm);
    const workerPath = join(binDir, 'bridge.js');
    writeFileSync(workerPath, `const identity = { artifactId: 'stockfish-js-wasm-sha256:${pins.jsSha256}:${pins.wasmSha256}' };`);
    expect(() => verifyStockfishArtifact({ binDir, artifact: pins, workerPath })).not.toThrow();
    writeFileSync(join(binDir, file), Buffer.concat([readFileSync(join(binDir, file)), Buffer.from('changed')]));
    expect(() => verifyStockfishArtifact({ binDir, artifact: pins, workerPath })).toThrow(`Stockfish artifact digest mismatch: ${file}`);
});

it('rejects a bridge claiming another artifact instead of silently changing its provenance or identity', () => {
    const folder = mkdtempSync(join(tmpdir(), 'backranq-artifact-')); folders.push(folder);
    const workerPath = join(folder, 'bridge.js');
    writeFileSync(workerPath, "const identity = { artifactId: 'unreviewed-build' };");
    expect(() => verifyStockfishArtifact({ binDir: join(process.cwd(), 'public/vendor/stockfish'), artifact, workerPath })).toThrow('bridge artifact identity');
});
