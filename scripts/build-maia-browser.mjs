import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(
    repositoryRoot,
    'public',
    'vendor',
    'maia'
);
const runtimeDirectory = path.dirname(
    path.dirname(require.resolve('onnxruntime-web'))
);
const expectedRuntimeVersion = '1.27.0';
const runtimePackage = JSON.parse(
    fs.readFileSync(
        path.join(runtimeDirectory, 'package.json'),
        'utf8'
    )
);
if (runtimePackage.version !== expectedRuntimeVersion) {
    throw new Error(
        `ONNX Runtime Web version mismatch: expected ${expectedRuntimeVersion}, installed ${runtimePackage.version ?? 'unknown'}. Update Maia metadata and integration revision deliberately.`
    );
}

fs.mkdirSync(outputDirectory, { recursive: true });

const runtimeArtifacts = [
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
];
for (const artifact of runtimeArtifacts) {
    const source = path.join(runtimeDirectory, 'dist', artifact);
    if (!fs.existsSync(source)) {
        throw new Error(
            `Missing ONNX Runtime Web artifact: ${source}`
        );
    }
    fs.copyFileSync(source, path.join(outputDirectory, artifact));
}

await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ['src/lib/coach/maia/worker.ts'],
    outfile: 'public/vendor/maia/backranq-maia.worker.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    sourcemap: false,
    tsconfig: 'tsconfig.json',
    legalComments: 'inline',
    banner: {
        js: `/* Backranq Maia worker. Includes ONNX Runtime Web ${expectedRuntimeVersion} (MIT); see THIRD_PARTY_NOTICES.md. */`,
    },
});

console.log(
    `[build-maia-browser] Built Maia worker and copied ONNX Runtime Web assets to ${outputDirectory}`
);
