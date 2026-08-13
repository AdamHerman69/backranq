import { describe, expect, it } from 'vitest';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunGenerationCurrent,
    isOwnerRunCurrent,
    resolveSessionOwnerId,
    type OwnerEpoch,
} from '@/lib/auth/ownerRun';

describe('owner run tokens', () => {
    it('drops an async result captured before an auth transition', () => {
        let epoch: OwnerEpoch = { ownerId: 'owner-a', generation: 1 };
        const importRun = captureOwnerRun(epoch);
        expect(importRun).not.toBeNull();

        epoch = advanceOwnerEpoch(epoch, 'owner-b');

        expect(isOwnerRunCurrent(importRun!, epoch)).toBe(false);
    });

    it('accepts only the current owner generation', () => {
        let epoch: OwnerEpoch = { ownerId: null, generation: 0 };
        epoch = advanceOwnerEpoch(epoch, 'owner-b');
        const enqueueRun = captureOwnerRun(epoch);
        expect(enqueueRun).not.toBeNull();
        expect(isOwnerRunCurrent(enqueueRun!, epoch)).toBe(true);

        epoch = advanceOwnerEpoch(epoch, null);

        expect(isOwnerRunCurrent(enqueueRun!, epoch)).toBe(false);
    });

    it('uses the server owner only while the live session is loading', () => {
        expect(
            resolveSessionOwnerId({
                sessionStatus: 'loading',
                liveOwnerId: null,
                initialOwnerId: 'owner-a',
            })
        ).toBe('owner-a');
        expect(
            resolveSessionOwnerId({
                sessionStatus: 'authenticated',
                liveOwnerId: 'owner-b',
                initialOwnerId: 'owner-a',
            })
        ).toBe('owner-b');
        expect(
            resolveSessionOwnerId({
                sessionStatus: 'unauthenticated',
                liveOwnerId: null,
                initialOwnerId: 'owner-a',
            })
        ).toBeNull();
    });

    it('rejects a stale generation even after switching A to B and back to A', () => {
        let epoch: OwnerEpoch = { ownerId: 'owner-a', generation: 1 };
        const staleRun = captureOwnerRun(epoch)!;
        epoch = advanceOwnerEpoch(epoch, 'owner-b');
        epoch = advanceOwnerEpoch(epoch, 'owner-a');

        expect(
            isOwnerRunGenerationCurrent({
                run: staleRun,
                epoch,
                generation: 1,
                currentGeneration: 3,
            })
        ).toBe(false);
    });
});
