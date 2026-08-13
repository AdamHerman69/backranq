import { describe, expect, it, vi } from 'vitest';
import {
    cleanupBrowserGameAnalysisRun,
    isBrowserGameAnalysisRunCurrent,
    type BrowserGameAnalysisRun,
} from '@/lib/analysis/browserGameAnalysisRun';

function createRun() {
    const cancelAll = vi.fn(() => undefined);
    const terminate = vi.fn(() => undefined);
    const run: BrowserGameAnalysisRun = {
        ownerId: 'owner-a',
        generation: 1,
        controller: new AbortController(),
        engine: {
            cancelAll,
            terminate,
        },
        cleaned: false,
    };
    return { cancelAll, run, terminate };
}

describe('browser game analysis run lifecycle', () => {
    it('aborts and terminates the worker exactly once', () => {
        const { cancelAll, run, terminate } = createRun();

        cleanupBrowserGameAnalysisRun(run);
        cleanupBrowserGameAnalysisRun(run);

        expect(run.controller.signal.aborted).toBe(true);
        expect(cancelAll).toHaveBeenCalledTimes(1);
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    it('still terminates when cancellation throws', () => {
        const { cancelAll, run, terminate } = createRun();
        cancelAll.mockImplementation(() => {
            throw new Error('cancel failed');
        });

        expect(() => cleanupBrowserGameAnalysisRun(run)).not.toThrow();
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    it('prevents a deferred save from committing after cancel', async () => {
        const { run, terminate } = createRun();
        let activeRun: typeof run | null = run;
        let generation = 1;
        let committed = false;
        let release!: () => void;
        const deferred = new Promise<void>((resolve) => {
            release = resolve;
        });
        const save = deferred.then(() => {
            if (
                isBrowserGameAnalysisRunCurrent({
                    run,
                    activeRun,
                    activeOwnerId: 'owner-a',
                    currentGeneration: generation,
                })
            ) {
                committed = true;
            }
        });

        activeRun = null;
        generation += 1;
        cleanupBrowserGameAnalysisRun(run);
        release();
        await save;

        expect(committed).toBe(false);
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    it('rejects a run after an owner transition', () => {
        const { run } = createRun();

        expect(
            isBrowserGameAnalysisRunCurrent({
                run,
                activeRun: run,
                activeOwnerId: 'owner-b',
                currentGeneration: 1,
            })
        ).toBe(false);
    });
});
