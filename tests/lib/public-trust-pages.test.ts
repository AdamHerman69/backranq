import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import NotFound from '@/app/not-found';
import PrivacyPage from '@/app/privacy/page';
import SupportPage from '@/app/support/page';
import TermsPage from '@/app/terms/page';

describe('public trust pages', () => {
    it('publishes a complete privacy page with support and terms navigation', () => {
        const markup = renderToStaticMarkup(PrivacyPage());
        expect(markup).toContain('Privacy Policy');
        expect(markup).toContain('Information we handle');
        expect(markup).toContain('support@backranq.com');
        expect(markup).toContain('href="/terms"');
        expect(markup).toContain('href="/support"');
    });

    it('publishes terms covering service, fair play and billing', () => {
        const markup = renderToStaticMarkup(TermsPage());
        expect(markup).toContain('Terms of Service');
        expect(markup).toContain('The Backranq service');
        expect(markup).toContain('live competitive game');
        expect(markup).toContain('Plans, credits and payment');
        expect(markup).toContain('href="/privacy"');
    });

    it('offers direct help for games, Practice, Coach and billing', () => {
        const markup = renderToStaticMarkup(SupportPage());
        expect(markup).toContain('Games and analysis');
        expect(markup).toContain('Practice and Coach');
        expect(markup).toContain('Plans and billing');
        expect(markup).toContain('href="/games"');
        expect(markup).toContain('href="/practice"');
        expect(markup).toContain('mailto:support@backranq.com');
    });

    it('gives a missing route safe paths back into the product', () => {
        const markup = renderToStaticMarkup(NotFound());
        expect(markup).toContain('Position not found');
        expect(markup).toContain('href="/"');
        expect(markup).not.toContain('href="/home"');
        expect(markup).not.toContain('href="/games"');
        expect(markup).toContain('href="/support"');
    });
});
