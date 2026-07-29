import { describe, expect, it } from 'vitest';
import { parseProgressRequest } from '@/lib/progress/query';

const NOW = new Date('2026-07-30T12:00:00.000Z');

describe('parseProgressRequest', () => {
    it('defaults to 90 days and no filters', () => {
        expect(
            parseProgressRequest(
                new URL('http://localhost/api/progress'),
                NOW
            )
        ).toEqual({
            scope: 90,
            asOf: NOW,
            filters: {
                providers: [],
                timeClasses: [],
            },
        });
    });

    it('parses repeatable and comma-separated filters', () => {
        const parsed = parseProgressRequest(
            new URL(
                'http://localhost/api/progress?scope=28&provider=lichess,chesscom&timeClass=rapid&timeClass=blitz'
            ),
            NOW
        );

        expect(parsed).toEqual({
            scope: 28,
            asOf: NOW,
            filters: {
                providers: ['LICHESS', 'CHESSCOM'],
                timeClasses: ['RAPID', 'BLITZ'],
            },
        });
    });

    it('rejects unknown values and keys, including client-owned snapshot times', () => {
        expect(
            parseProgressRequest(
                new URL(
                    'http://localhost/api/progress?provider=OTHER'
                ),
                NOW
            )
        ).toBeNull();
        expect(
            parseProgressRequest(
                new URL(
                    'http://localhost/api/progress?unexpected=true'
                ),
                NOW
            )
        ).toBeNull();
        expect(
            parseProgressRequest(
                new URL(
                    'http://localhost/api/progress?asOf=2026-07-01T00%3A00%3A00.000Z'
                ),
                NOW
            )
        ).toBeNull();
    });
});
