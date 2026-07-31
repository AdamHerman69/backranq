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
    STOCKFISH_BROWSER_REVISION,
    STOCKFISH_BROWSER_WORKER_URL,
} from '@/lib/analysis/stockfishMetadata';

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
    it('versions both the worker request and its service-worker cache', () => {
        expect(STOCKFISH_BROWSER_WORKER_URL).toContain(
            encodeURIComponent(STOCKFISH_BROWSER_REVISION)
        );
        expect(STOCKFISH_BROWSER_CACHE_NAME).toContain(
            STOCKFISH_BROWSER_REVISION
        );
        expect(
            readFileSync(
                resolve(
                    process.cwd(),
                    'public/vendor/stockfish/backranq-engine.worker.js'
                ),
                'utf8'
            )
        ).toContain(
            `const runtimeRevision = '${STOCKFISH_BROWSER_REVISION}'`
        );
    });
});

describe('restricted Stockfish roots', () => {
    it('normalizes exact roots and rejects empty, duplicate, or malformed sets', () => {
        expect(
            normalizeRestrictedRootMoves([' E2E4 ', 'd2d4'])
        ).toEqual(['e2e4', 'd2d4']);
        expect(() => normalizeRestrictedRootMoves([])).toThrow(
            'between 1 and 8'
        );
        expect(() =>
            normalizeRestrictedRootMoves(['e2e4', 'E2E4'])
        ).toThrow('unique');
        expect(() =>
            normalizeRestrictedRootMoves(['e2e4junk'])
        ).toThrow('unique');
    });
});
