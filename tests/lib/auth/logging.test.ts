import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    authDebugEnabled,
    createSafeAuthLogger,
} from '@/lib/auth/logging';

describe('Auth.js logging safety', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('cannot enable verbose Auth.js debug logging in production', () => {
        expect(
            authDebugEnabled({
                NODE_ENV: 'production',
                NEXTAUTH_DEBUG: 'true',
            })
        ).toBe(false);
        expect(
            authDebugEnabled({
                NODE_ENV: 'development',
                NEXTAUTH_DEBUG: 'true',
            })
        ).toBe(true);
    });

    it('logs only the event code and omits request, cookie and OIDC metadata', () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const logger = createSafeAuthLogger(true);
        const request = new Request('https://backranq.test/api/auth/callback', {
            headers: {
                authorization: 'Bearer oauth-access-secret',
                cookie: 'session=private-cookie',
            },
        });

        logger.debug('oauth_callback', {
            request,
            access_token: 'oauth-access-secret',
            id_token: 'oidc-id-secret',
        });

        expect(debug).toHaveBeenCalledWith(
            '[auth][debug]',
            'oauth_callback'
        );
        const rendered = JSON.stringify(debug.mock.calls);
        expect(rendered).not.toContain('oauth-access-secret');
        expect(rendered).not.toContain('private-cookie');
        expect(rendered).not.toContain('oidc-id-secret');
    });

    it('logs only Error class names and ignores messages, callback URLs and extra properties', () => {
        const errorLog = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        const logger = createSafeAuthLogger(false);
        const cause = new Error(
            'authorization=Bearer super-secret cookie=session-secret'
        );
        const error = Object.assign(
            new Error(
                'callback failed at https://backranq.test/api/auth/callback?code=authorization-secret&state=oauth-state&session_state=oidc-state token=oauth-secret id_token=oidc-secret eyJhbGciOiJIUzI1NiJ9.payload.signature',
                { cause }
            ),
            {
                request: new Request('https://backranq.test/private'),
                refresh_token: 'refresh-secret',
            }
        );

        logger.error(error);

        const rendered = JSON.stringify(errorLog.mock.calls);
        expect(rendered).toContain('Error');
        expect(rendered).not.toContain('super-secret');
        expect(rendered).not.toContain('session-secret');
        expect(rendered).not.toContain('oauth-secret');
        expect(rendered).not.toContain('oidc-secret');
        expect(rendered).not.toContain('refresh-secret');
        expect(rendered).not.toContain('https://backranq.test/private');
        expect(rendered).not.toContain('authorization-secret');
        expect(rendered).not.toContain('oauth-state');
        expect(rendered).not.toContain('oidc-state');
        expect(rendered).not.toContain('/api/auth/callback');
    });
});
