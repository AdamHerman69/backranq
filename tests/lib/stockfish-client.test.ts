import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    isStructurallyCompleteMultiPvBundle,
    normalizeRestrictedRootMoves,
    type MultiPvLine,
} from '@/lib/analysis/stockfishClient';
import {
    STOCKFISH_BROWSER_CACHE_NAME,
    STOCKFISH_BROWSER_NESTED_WORKER_URL,
    STOCKFISH_BROWSER_REVISION,
    STOCKFISH_BROWSER_RUNTIME_ASSET_URLS,
    STOCKFISH_BROWSER_WASM_URL,
} from '@/lib/analysis/stockfishMetadata';
import { allowsPublicEnginePrewarm } from '@/lib/hooks/usePublicPuzzleSession';

function line(multipv: number, move: string): MultiPvLine {
    return {
        multipv,
        pvUci: [move],
        score: { type: 'cp', value: 0 },
    };
}

describe('browser Stockfish MultiPV completeness', () => {
    it('accepts only a contiguous, unique, exact bundle with every requested slot', () => {
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(2, 'd2d4'), line(1, 'e2e4'), line(3, 'g1f3')],
                3
            )
        ).toBe(true);
    });

    it('keeps a partial browser snapshot incomplete', () => {
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'e2e4'), line(2, 'd2d4')],
                3
            )
        ).toBe(false);
    });

    it('rejects non-contiguous, duplicate-root, and malformed browser bundles', () => {
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'e2e4'), line(3, 'd2d4')],
                2
            )
        ).toBe(false);
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'e2e4'), line(2, 'E2E4')],
                2
            )
        ).toBe(false);
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'not-a-move'), line(2, 'd2d4')],
                2
            )
        ).toBe(false);
    });
});

describe('browser Stockfish asset revision', () => {
    it('versions every runtime request and its service-worker cache', () => {
        for (const assetUrl of STOCKFISH_BROWSER_RUNTIME_ASSET_URLS) {
            expect(assetUrl).toContain(
                encodeURIComponent(STOCKFISH_BROWSER_REVISION)
            );
        }
        expect(STOCKFISH_BROWSER_NESTED_WORKER_URL).toContain('.js?v=');
        expect(STOCKFISH_BROWSER_WASM_URL).toContain('.wasm?v=');
        expect(STOCKFISH_BROWSER_CACHE_NAME).toContain(
            STOCKFISH_BROWSER_REVISION
        );
        const workerSource = readFileSync(
            resolve(
                process.cwd(),
                'public/vendor/stockfish/backranq-engine.worker.js'
            ),
            'utf8'
        );
        expect(workerSource).toContain(
            `const runtimeRevision = '${STOCKFISH_BROWSER_REVISION}'`
        );
        expect(workerSource).toContain("'stockfish-18-lite-single.wasm'");
        expect(workerSource).toContain('workerUrl.hash =');
    });
});

describe('public puzzle engine intent', () => {
    it('allows speculative post-intent warmup unless data saving is enabled', () => {
        expect(allowsPublicEnginePrewarm(undefined)).toBe(true);
        expect(allowsPublicEnginePrewarm({ saveData: false })).toBe(true);
        expect(allowsPublicEnginePrewarm({ saveData: true })).toBe(false);
    });
});

describe('restricted Stockfish roots', () => {
    it('normalizes exact roots and rejects empty, duplicate, or malformed sets', () => {
        expect(
            normalizeRestrictedRootMoves([' E2E4 ', 'd2d4'])
        ).toEqual(['d2d4', 'e2e4']);
        expect(() => normalizeRestrictedRootMoves([])).toThrow(
            'nonempty legal root scope'
        );
        expect(() =>
            normalizeRestrictedRootMoves(['e2e4', 'E2E4'])
        ).toThrow('unique');
        expect(() =>
            normalizeRestrictedRootMoves(['e2e4junk'])
        ).toThrow('unique');
    });
});
