import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';

const nextDir = path.join(process.cwd(), '.next');
const routeBudgets = [
    {
        route: '/',
        manifest: 'server/app/page_client-reference-manifest.js',
        gzipBudgetBytes: 250 * 1024,
    },
    {
        route: '/login',
        manifest: 'server/app/login/page_client-reference-manifest.js',
        gzipBudgetBytes: 100 * 1024,
    },
    {
        route: '/home',
        manifest:
            'server/app/(app)/home/page_client-reference-manifest.js',
        gzipBudgetBytes: 250 * 1024,
    },
    {
        route: '/games',
        manifest:
            'server/app/(app)/games/page_client-reference-manifest.js',
        gzipBudgetBytes: 250 * 1024,
    },
    {
        route: '/practice',
        manifest:
            'server/app/(app)/practice/page_client-reference-manifest.js',
        gzipBudgetBytes: 250 * 1024,
    },
    {
        route: '/games/[id]',
        manifest:
            'server/app/(app)/games/[id]/page_client-reference-manifest.js',
        gzipBudgetBytes: 225 * 1024,
    },
    {
        route: '/play',
        manifest:
            'server/app/(app)/play/page_client-reference-manifest.js',
        gzipBudgetBytes: 240 * 1024,
    },
    {
        route: '/settings',
        manifest:
            'server/app/(app)/settings/page_client-reference-manifest.js',
        gzipBudgetBytes: 180 * 1024,
    },
];

const failures = [];

for (const budget of routeBudgets) {
    const manifestPath = path.join(nextDir, budget.manifest);
    const manifestSource = await readFile(manifestPath, 'utf8').catch(
        (error) => {
            throw new Error(
                `Missing Next.js client reference manifest for ${budget.route}. Run \`pnpm build\` first.`,
                { cause: error }
            );
        }
    );
    const sandbox = {};
    sandbox.globalThis = sandbox;
    vm.runInNewContext(manifestSource, sandbox, {
        filename: manifestPath,
        timeout: 1_000,
    });

    const routeManifests = Object.values(
        sandbox.__RSC_MANIFEST ?? {}
    );
    if (routeManifests.length !== 1) {
        throw new Error(
            `Unexpected Next.js client reference manifest shape for ${budget.route}.`
        );
    }
    const routeManifest = routeManifests[0];
    if (!routeManifest?.entryJSFiles) {
        throw new Error(
            `Next.js client reference manifest has no entryJSFiles for ${budget.route}.`
        );
    }

    const chunkPaths = [
        ...new Set(Object.values(routeManifest.entryJSFiles).flat()),
    ];
    let rawBytes = 0;
    let gzipBytes = 0;
    for (const chunkPath of chunkPaths) {
        if (
            typeof chunkPath !== 'string' ||
            path.isAbsolute(chunkPath) ||
            chunkPath.split('/').includes('..')
        ) {
            throw new Error(
                `Unsafe client chunk path in ${budget.route} manifest: ${String(chunkPath)}`
            );
        }
        const chunk = await readFile(path.join(nextDir, chunkPath));
        rawBytes += chunk.byteLength;
        gzipBytes += gzipSync(chunk).byteLength;
    }

    const result = {
        route: budget.route,
        chunks: chunkPaths.length,
        rawKiB: rawBytes / 1024,
        gzipKiB: gzipBytes / 1024,
        budgetKiB: budget.gzipBudgetBytes / 1024,
    };
    console.log(
        `${result.route}: ${result.gzipKiB.toFixed(1)} KiB gzip / ${result.budgetKiB.toFixed(0)} KiB (${result.chunks} initial JS chunks, ${result.rawKiB.toFixed(1)} KiB raw)`
    );
    if (gzipBytes > budget.gzipBudgetBytes) failures.push(result);
}

if (failures.length > 0) {
    throw new Error(
        `Client bundle budget exceeded: ${failures
            .map(
                (failure) =>
                    `${failure.route} ${failure.gzipKiB.toFixed(1)} KiB > ${failure.budgetKiB.toFixed(0)} KiB`
            )
            .join(', ')}`
    );
}
