import { expect, it, vi } from 'vitest';
import type { StockfishClient } from '@/lib/analysis/stockfishClient';
import { createPuzzleEngineHandoff } from '@/lib/onboarding/puzzleEngineHandoff';

it('holds the search runtime until the matching puzzle claims it, then only the session may stop it', () => {
    const terminate = vi.fn();
    const engine = { terminate } as unknown as StockfishClient;
    const handoff = createPuzzleEngineHandoff(engine, 'personal-revision');
    expect(handoff.take('master-revision')).toBeNull();
    expect(terminate).not.toHaveBeenCalled();
    expect(handoff.take('personal-revision')).toBe(engine);
    expect(handoff.take('personal-revision')).toBeNull();
    handoff.dispose();
    expect(terminate).not.toHaveBeenCalled();
    engine.terminate();
    expect(terminate).toHaveBeenCalledTimes(1);
});

it('cancels an unclaimed search runtime once and never transfers a disposed engine', () => {
    const terminate = vi.fn();
    const handoff = createPuzzleEngineHandoff({ terminate } as unknown as StockfishClient, 'cancelled');
    handoff.dispose(); handoff.dispose();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(handoff.take('cancelled')).toBeNull();
});
