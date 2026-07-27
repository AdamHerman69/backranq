import { describe, expect, it } from 'vitest';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunCurrent,
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
});
