import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncVerifiedLichessIdentity = vi.fn(async () => true);
let capturedConfig: {
    callbacks?: {
        session?: (event: {
            session: {
                expires: Date;
                sessionToken: string;
                userId: string;
                user: Record<string, unknown>;
            };
            user: {
                id: string;
                name: string | null;
                email: string | null;
                image: string | null;
                preferences: Record<string, unknown>;
            };
        }) => unknown;
    };
    events?: { signIn?: (event: Record<string, unknown>) => Promise<void> };
};

describe('Auth.js provider events', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        capturedConfig = {};
        vi.doMock('next-auth', () => ({
            default: (config: typeof capturedConfig) => {
                capturedConfig = config;
                return {
                    handlers: {},
                    auth: vi.fn(),
                    signIn: vi.fn(),
                    signOut: vi.fn(),
                };
            },
        }));
        vi.doMock('@auth/prisma-adapter', () => ({ PrismaAdapter: vi.fn(() => ({})) }));
        vi.doMock('@/lib/prisma', () => ({ prisma: {} }));
        vi.doMock('@/lib/auth/config', () => ({ authConfig: { providers: [] } }));
        vi.doMock('@/lib/auth/lichessIdentity', () => ({ syncVerifiedLichessIdentity }));
    });

    it('wires successful sign-ins into verified Lichess onboarding', async () => {
        await import('@/lib/auth');
        const event = {
            user: { id: 'user-1' },
            account: { provider: 'lichess', providerAccountId: 'stable-id' },
            profile: { id: 'stable-id', username: 'Ada' },
        };
        await capturedConfig.events?.signIn?.(event);
        expect(syncVerifiedLichessIdentity).toHaveBeenCalledWith(event);
    });

    it('exposes only the explicit public session contract', async () => {
        await import('@/lib/auth');

        const session = capturedConfig.callbacks?.session?.({
            session: {
                expires: new Date('2026-08-24T06:00:00.000Z'),
                sessionToken: 'must-not-reach-the-client',
                userId: 'user-1',
                user: { preferences: { private: true } },
            },
            user: {
                id: 'user-1',
                name: 'Ada',
                email: 'ada@example.com',
                image: null,
                preferences: { private: true },
            },
        });

        expect(session).toEqual({
            expires: '2026-08-24T06:00:00.000Z',
            user: {
                id: 'user-1',
                name: 'Ada',
                email: 'ada@example.com',
                image: null,
            },
        });
        expect(session).not.toHaveProperty('sessionToken');
        expect(session).not.toHaveProperty('user.preferences');
    });
});
