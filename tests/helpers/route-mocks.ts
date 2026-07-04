import { vi } from 'vitest';

type MockSession = {
    user?: {
        id?: string;
        name?: string | null;
        email?: string | null;
        image?: string | null;
    };
} | null;

type DelegateMethod = ReturnType<
    typeof vi.fn<(...args: unknown[]) => Promise<unknown>>
>;
type DelegateMock = Record<string, DelegateMethod>;

function createDelegateMock() {
    const methods: DelegateMock = {};

    return new Proxy(methods, {
        get(target, property) {
            if (typeof property !== 'string') return undefined;
            target[property] ??= vi.fn();
            return target[property];
        },
    });
}

function createPrismaMock() {
    const delegates: Record<string, DelegateMock> = {};

    return new Proxy(delegates, {
        get(target, property) {
            if (typeof property !== 'string') return undefined;
            target[property] ??= createDelegateMock();
            return target[property];
        },
    });
}

export const authMock = vi.fn<() => Promise<MockSession>>(async () => null);
export const prismaMock = createPrismaMock();

export function mockAuthModule() {
    vi.doMock('@/lib/auth', () => ({
        auth: authMock,
        handlers: { GET: vi.fn(), POST: vi.fn() },
        signIn: vi.fn(),
        signOut: vi.fn(),
    }));
}

export function mockPrismaModule() {
    vi.doMock('@/lib/prisma', () => ({ prisma: prismaMock }));
}

export function setMockUserId(userId: string | null) {
    authMock.mockResolvedValue(userId ? { user: { id: userId } } : null);
}

export function resetRouteMocks() {
    authMock.mockResolvedValue(null);
}
