import { describe, expect, it } from 'vitest';
import {
    isScopedResultVisible,
    LatestRequestLifecycle,
} from '@/lib/api/requestLifecycle';

describe('LatestRequestLifecycle', () => {
    it('rejects a slow request A after faster request B starts', () => {
        const lifecycle = new LatestRequestLifecycle();
        const requestA = lifecycle.begin();
        const requestB = lifecycle.begin();

        expect(requestA.signal.aborted).toBe(true);
        expect(lifecycle.isCurrent(requestA.sequence)).toBe(false);
        expect(lifecycle.isCurrent(requestB.sequence)).toBe(true);
    });

    it('invalidates in-flight work when a query is disabled or unmounted', () => {
        const lifecycle = new LatestRequestLifecycle();
        const request = lifecycle.begin();

        lifecycle.cancel();

        expect(request.signal.aborted).toBe(true);
        expect(lifecycle.isCurrent(request.sequence)).toBe(false);
    });

    it('keeps a failed first request scoped to the new owner', () => {
        const lifecycle = new LatestRequestLifecycle();
        const ownerA = lifecycle.begin('owner-a');
        const ownerB = lifecycle.begin('owner-b');
        const firstOwnerBError = 'Owner B request failed';

        expect(lifecycle.isCurrent(ownerA.sequence, 'owner-a')).toBe(false);
        expect(lifecycle.isCurrent(ownerB.sequence, 'owner-a')).toBe(false);
        expect(lifecycle.isCurrent(ownerB.sequence, 'owner-b')).toBe(true);
        expect(
            isScopedResultVisible(
                true,
                ownerB.scopeKey,
                'owner-b'
            )
                ? firstOwnerBError
                : null
        ).toBe(firstOwnerBError);
    });
});
