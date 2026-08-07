import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncVerifiedLichessIdentity = vi.fn(async () => true);
let capturedConfig: {
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
});
