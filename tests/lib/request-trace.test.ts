import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    currentRequestTrace,
    measurePrismaOperation,
    measureRequestPhase,
    withRequestTrace,
} from '@/lib/performance/requestTrace';

describe('request performance trace', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('adds bounded timing metadata without request contents', async () => {
        vi.stubEnv('VERCEL_REGION', 'dub1');
        vi.stubEnv('BACKRANQ_QUEUE_REGION', 'iad1');

        const response = await withRequestTrace(
            {
                route: '/api/example',
                request: new Request('http://localhost/api/example', {
                    headers: { 'x-vercel-id': 'dub1::safe-request-id' },
                }),
            },
            async () => {
                await measureRequestPhase('auth', async () => undefined);
                await measurePrismaOperation(async () => undefined);
                return Response.json({ ok: true });
            }
        );

        expect(response.headers.get('server-timing')).toMatch(
            /^auth;dur=\d+(?:\.\d+)?, db_ops_sum;dur=\d+(?:\.\d+)?, total;dur=\d+(?:\.\d+)?$/
        );
        expect(response.headers.get('x-backranq-request-id')).toBe(
            'dub1::safe-request-id'
        );
        expect(response.headers.get('x-backranq-function-region')).toBe('dub1');
        expect(response.headers.get('x-backranq-queue-region')).toBe('iad1');
        expect(response.headers.get('x-backranq-db-operation-count')).toBe('1');
        expect(await response.json()).toEqual({ ok: true });
    });

    it('keeps concurrent traces isolated', async () => {
        const release: Array<() => void> = [];
        const runs = [1, 2].map((queryCount) =>
            withRequestTrace({ route: `/api/${queryCount}` }, async () => {
                for (let index = 0; index < queryCount; index += 1) {
                    await measurePrismaOperation(async () => undefined);
                }
                await new Promise<void>((resolve) => release.push(resolve));
                expect(currentRequestTrace()?.dbOperationCount).toBe(queryCount);
                return new Response(null, { status: 204 });
            })
        );
        await vi.waitFor(() => expect(release).toHaveLength(2));
        release.forEach((resolve) => resolve());
        const responses = await Promise.all(runs);

        expect(
            responses.map((response) =>
                response.headers.get('x-backranq-db-operation-count')
            )
        ).toEqual(['1', '2']);
    });

    it('rejects unbounded phase names before recording them', async () => {
        await expect(
            measureRequestPhase('user:private-value', async () => undefined)
        ).rejects.toThrow('Invalid request performance phase');
    });

    it('emits a sampled structured log with fixed trace fields', async () => {
        vi.stubEnv('BACKRANQ_PERFORMANCE_LOGS', 'true');
        vi.stubEnv('BACKRANQ_PERFORMANCE_SAMPLE_RATE', '1');
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await withRequestTrace({ route: '/api/example' }, async () =>
            Response.json({ ok: true })
        );

        expect(info).toHaveBeenCalledOnce();
        const logged = JSON.parse(String(info.mock.calls[0]?.[0]));
        expect(logged).toMatchObject({
            level: 'info',
            event: 'request.performance',
            outcome: 'done',
            route: '/api/example',
            status: 200,
        });
        expect(Object.keys(logged).sort()).toEqual(
            [
                'coldStart',
                'dbOperationDurationSumMs',
                'dbOperationCount',
                'event',
                'functionRegion',
                'level',
                'outcome',
                'phases',
                'queueRegion',
                'requestId',
                'route',
                'status',
                'totalDurationMs',
            ].sort()
        );
    });
});
