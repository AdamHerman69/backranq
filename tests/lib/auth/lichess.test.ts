import { describe, expect, it, vi } from 'vitest';
import LichessProvider from '@/lib/auth/providers/lichess';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, init?: ResponseInit) {
    return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
    });
}

describe('Lichess OAuth provider', () => {
    it('maps Lichess profiles with no email to nullable Auth.js users', () => {
        const provider = LichessProvider({ clientId: 'test-client' });

        expect(
            provider.profile?.({ id: 'lichess-id', username: 'Ada' }, {})
        ).toEqual({
            id: 'lichess-id',
            name: 'Ada',
            email: null,
            image: null,
        });
    });

    it('keeps userinfo usable when Lichess returns an account but no email', async () => {
        const provider = LichessProvider({ clientId: 'test-client' });
        const request = provider.userinfo?.request;
        expect(request).toBeTypeOf('function');

        const fetchMock = vi.fn(async (...args: FetchArgs) => {
            const url = String(args[0]);
            if (url.endsWith('/api/account')) {
                return jsonResponse({ id: 'lichess-id', username: 'Ada' });
            }
            if (url.endsWith('/api/account/email')) {
                return jsonResponse({});
            }
            return new Response(null, { status: 404 });
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            request?.({ tokens: { access_token: 'token' } })
        ).resolves.toEqual({
            id: 'lichess-id',
            username: 'Ada',
            email: null,
        });
    });
});
