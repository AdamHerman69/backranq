import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from '@/proxy';

describe('root routing', () => {
    it('keeps the static landing page for a signed-out visitor', async () => {
        const response = await proxy(
            new NextRequest('https://backranq.test/?utm_source=test')
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('x-middleware-next')).toBe('1');
    });

    it('sends a session-cookie visitor directly to Home', async () => {
        const response = await proxy(
            new NextRequest('https://backranq.test/?utm_source=test', {
                headers: {
                    cookie: 'authjs.session-token=opaque-database-session',
                },
            })
        );

        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
            'https://backranq.test/home'
        );
    });
});
