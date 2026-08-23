import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
    return readFileSync(path, 'utf8');
}

describe('public and authenticated layout boundary', () => {
    it('keeps the root layout free of authenticated client infrastructure', () => {
        const rootLayout = source('src/app/layout.tsx');

        expect(rootLayout).not.toContain('AppShell');
        expect(rootLayout).not.toContain('SessionProvider');
        expect(rootLayout).not.toContain('SonnerToaster');
        expect(rootLayout).not.toContain('@/lib/auth');
    });

    it('owns authenticated infrastructure only in the app route group', () => {
        const appLayout = source('src/app/(app)/layout.tsx');
        const provider = source(
            'src/components/auth/SessionProvider.tsx'
        );

        expect(appLayout).toContain('getRequestSession()');
        expect(appLayout).toContain(
            '<SessionProvider initialSession={session}>'
        );
        expect(appLayout).toContain('<AppShell');
        expect(appLayout).toContain('<SonnerToaster />');
        expect(provider).toContain('session={initialSession}');
    });

    it('keeps protected URLs in the route group without compatibility aliases', () => {
        for (const route of [
            'home',
            'practice',
            'play',
            'games',
            'progress',
            'settings',
            'profile',
            'admin',
        ]) {
            expect(
                existsSync(`src/app/(app)/${route}/page.tsx`) ||
                    existsSync(`src/app/(app)/${route}/layout.tsx`)
            ).toBe(true);
            expect(existsSync(`src/app/${route}/page.tsx`)).toBe(false);
            expect(existsSync(`src/app/${route}/layout.tsx`)).toBe(false);
        }
    });

    it('shares the request-local session read across every protected guard', () => {
        const guardedEntries = [
            'src/app/(app)/home/page.tsx',
            'src/app/(app)/practice/page.tsx',
            'src/app/(app)/play/page.tsx',
            'src/app/(app)/games/page.tsx',
            'src/app/(app)/games/[id]/page.tsx',
            'src/app/(app)/progress/page.tsx',
            'src/app/(app)/settings/page.tsx',
            'src/app/(app)/profile/page.tsx',
            'src/app/(app)/admin/layout.tsx',
            'src/lib/auth/admin.ts',
        ];

        for (const entry of guardedEntries) {
            const guardedSource = source(entry);
            expect(guardedSource).toContain('getRequestSession');
            expect(guardedSource).not.toMatch(/\bauth\(\)/);
            expect(guardedSource).not.toContain("from '@/lib/auth'");
        }
    });

    it('keeps the offline fallback static and outside authenticated session reads', () => {
        const offlinePage = source('src/app/~offline/coach/page.tsx');
        const offlineLayout = source('src/app/~offline/layout.tsx');

        expect(offlinePage).toContain("dynamic = 'force-static'");
        expect(offlineLayout).not.toContain('SessionProvider');
        expect(offlineLayout).not.toContain('@/lib/auth');
    });

    it('keeps public invite sign-out independent of app providers and Sonner', () => {
        const signOutButton = source(
            'src/components/auth/SignOutButton.tsx'
        );
        const invitePage = source('src/app/invite/[token]/page.tsx');

        expect(signOutButton).not.toContain('useSession');
        expect(signOutButton).not.toContain("from 'sonner'");
        expect(invitePage).toContain(
            'ownerId={session?.user?.id}'
        );
    });
});
