import { describe, expect, it } from 'vitest';
import {
    DEFAULT_AUTH_CALLBACK_URL,
    safeAuthCallbackUrl,
} from '@/lib/auth/callbackUrl';

describe('safeAuthCallbackUrl', () => {
    it.each([
        ['/home', '/home'],
        ['/practice?momentId=123#review', '/practice?momentId=123#review'],
        ['/', '/'],
    ])('keeps a same-origin relative callback', (value, expected) => {
        expect(safeAuthCallbackUrl(value)).toBe(expected);
    });

    it.each([
        undefined,
        null,
        '',
        'https://attacker.test/path',
        'http://attacker.test/path',
        'javascript:alert(1)',
        '//attacker.test/path',
        '///attacker.test/path',
        '/%2f%2fattacker.test/path',
        '/%252f%252fattacker.test/path',
        '/%25252525252f%25252525252fattacker.test/path',
        '/.//attacker.test',
        '/safe/..//attacker.test',
        '/%2e%2e//attacker.test',
        '/\\attacker.test/path',
        '/%5cattacker.test/path',
        '/%255cattacker.test/path',
        '/home\n',
        '/home\u0000',
        '/%0aattacker.test/path',
        '/%250aattacker.test/path',
        ' /home',
        '/home ',
        '/%',
    ])('rejects unsafe callback %j', (value) => {
        expect(safeAuthCallbackUrl(value)).toBe(
            DEFAULT_AUTH_CALLBACK_URL
        );
    });

    it('uses a safe caller-provided fallback', () => {
        expect(safeAuthCallbackUrl(undefined, '/practice')).toBe(
            '/practice'
        );
    });

    it('does not trust an unsafe caller-provided fallback', () => {
        expect(
            safeAuthCallbackUrl(undefined, 'https://attacker.test')
        ).toBe(DEFAULT_AUTH_CALLBACK_URL);
    });
});
