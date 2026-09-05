import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appUrl } from '@/lib/stripe';

describe('Stripe application URL', () => {
    beforeEach(() => {
        vi.stubEnv('BACKRANQ_APP_URL', undefined);
        vi.stubEnv('NEXTAUTH_URL', undefined);
        vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', undefined);
    });
    afterEach(() => vi.unstubAllEnvs());

    it('creates absolute redirect and invitation URLs from the Vercel hostname', () => {
        vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'backranq.vercel.app');
        const base = appUrl();

        expect(base).toBe('https://backranq.vercel.app');
        for (const path of [
            '/settings?billing=success',
            '/settings?billing=cancelled',
            '/settings?billing=portal-return',
            '/invite/token',
        ]) {
            const destination = new URL(`${base}${path}`);
            expect(destination.origin).toBe('https://backranq.vercel.app');
        }
    });

    it('prefers the explicit app URL over auth and deployment URLs', () => {
        vi.stubEnv('BACKRANQ_APP_URL', 'https://backranq.com/');
        vi.stubEnv('NEXTAUTH_URL', 'https://auth.example/');
        vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'backranq.vercel.app');
        expect(appUrl()).toBe('https://backranq.com');
    });

    it('uses the auth URL ahead of the deployment hostname', () => {
        vi.stubEnv('NEXTAUTH_URL', 'http://localhost:4000/');
        vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'backranq.vercel.app');
        expect(appUrl()).toBe('http://localhost:4000');
    });

    it('defaults to local development when no app URL is configured', () => {
        expect(appUrl()).toBe('http://localhost:3000');
    });
});
