import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = process.cwd();
const runtimeParent = path.join(
    repositoryRoot,
    'artifacts',
    'extraction-quality-lab'
);
fs.mkdirSync(runtimeParent, { recursive: true });
const temporaryDirectory = fs.mkdtempSync(
    path.join(runtimeParent, 'runtime-')
);
const outputFile = path.join(temporaryDirectory, 'runner.mjs');

try {
    await build({
        absWorkingDir: repositoryRoot,
        entryPoints: ['scripts/extraction-quality-lab.ts'],
        outfile: outputFile,
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        target: ['node20'],
        tsconfig: 'tsconfig.json',
        sourcemap: false,
        legalComments: 'none',
    });
    const runnerModule = await import(pathToFileURL(outputFile).href);
    await runnerModule.main(process.argv.slice(2));
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
