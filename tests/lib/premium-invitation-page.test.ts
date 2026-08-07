import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, invitationPreviewMock } = vi.hoisted(() => ({
    authMock: vi.fn(),
    invitationPreviewMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/premium/invitations', () => ({
    invitationPreview: invitationPreviewMock,
    normalizeAccountEmail: (value: string) => value.trim().toLowerCase(),
}));
vi.mock('@/components/admin/AdminSubmitButton', async () => {
    const React = await import('react');
    return {
        AdminSubmitButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement> & { pendingLabel: string }) =>
            React.createElement('button', null, props.children),
    };
});
vi.mock('@/components/auth/SignOutButton', async () => {
    const React = await import('react');
    return {
        SignOutButton: ({ children, callbackUrl }: { children: React.ReactNode; callbackUrl?: string }) =>
            React.createElement('button', { 'data-callback-url': callbackUrl }, children),
    };
});
vi.mock('@/app/invite/[token]/actions', () => ({
    acceptPremiumInvitationAction: vi.fn(),
}));

import PremiumInvitationPage from '@/app/invite/[token]/page';

const validInvitation = {
    email: 'invited@example.com',
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    activeKey: 'active',
};

async function renderPage(error?: string) {
    return renderToStaticMarkup(
        await PremiumInvitationPage({
            params: Promise.resolve({ token: 'safe-token' }),
            searchParams: Promise.resolve(error ? { error } : {}),
        })
    );
}

describe('premium invitation page states', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authMock.mockResolvedValue(null);
        invitationPreviewMock.mockResolvedValue(validInvitation);
    });

    it('lets a signed-out recipient sign in and return to the invitation', async () => {
        const markup = await renderPage();
        expect(markup).toContain('Sign in to accept');
        expect(markup).toContain('href="/login?callbackUrl=%2Finvite%2Fsafe-token"');
        expect(markup).toContain('Not ready yet');
    });

    it('offers recovery actions for an invalid or expired invitation', async () => {
        invitationPreviewMock.mockResolvedValue(null);
        const markup = await renderPage();
        expect(markup).toContain('This invitation is no longer available');
        expect(markup).toContain('href="/support"');
        expect(markup).toContain('Explore Backranq');
    });

    it('helps a recipient switch when the signed-in email does not match', async () => {
        authMock.mockResolvedValue({ user: { id: 'user-1', email: 'different@example.com' } });
        const markup = await renderPage();
        expect(markup).toContain('Switch account');
        expect(markup).toContain('data-callback-url="/invite/safe-token"');
        expect(markup).toContain('Get help');
    });

    it('shows the activation action to the invited account', async () => {
        authMock.mockResolvedValue({ user: { id: 'user-1', email: 'INVITED@example.com' } });
        const markup = await renderPage();
        expect(markup).toContain('Accept Pro invitation');
        expect(markup).toContain('name="token" value="safe-token"');
    });

    it('gives an accepted recipient direct product and plan actions', async () => {
        authMock.mockResolvedValue({ user: { id: 'user-1', email: 'invited@example.com' } });
        invitationPreviewMock.mockResolvedValue({
            ...validInvitation,
            acceptedAt: new Date('2026-08-01T00:00:00.000Z'),
            activeKey: null,
        });
        const markup = await renderPage();
        expect(markup).toContain('Start practicing');
        expect(markup).toContain('href="/practice"');
        expect(markup).toContain('href="/settings#billing"');
    });

    it('asks a signed-out visitor to authenticate before opening an accepted invitation', async () => {
        invitationPreviewMock.mockResolvedValue({
            ...validInvitation,
            acceptedAt: new Date('2026-08-01T00:00:00.000Z'),
            activeKey: null,
        });
        const markup = await renderPage();
        expect(markup).toContain('Sign in to continue');
        expect(markup).toContain('href="/login?callbackUrl=%2Finvite%2Fsafe-token"');
        expect(markup).not.toContain('href="/practice"');
        expect(markup).not.toContain('href="/settings#billing"');
    });

    it('does not expose accepted product actions to a different signed-in account', async () => {
        authMock.mockResolvedValue({ user: { id: 'user-1', email: 'different@example.com' } });
        invitationPreviewMock.mockResolvedValue({
            ...validInvitation,
            acceptedAt: new Date('2026-08-01T00:00:00.000Z'),
            activeKey: null,
        });
        const markup = await renderPage();
        expect(markup).toContain('Switch account');
        expect(markup).toContain('Pro is active on the invited account');
        expect(markup).not.toContain('href="/practice"');
        expect(markup).not.toContain('href="/settings#billing"');
    });

    it('keeps a server-action error visible beside recovery links', async () => {
        const markup = await renderPage('The invitation could not be accepted');
        expect(markup).toContain('The invitation could not be accepted');
        expect(markup).toContain('role="alert"');
        expect(markup).toContain('href="/support"');
    });
});
