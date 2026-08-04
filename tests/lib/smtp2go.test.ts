import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    sendSmtp2GoEmail,
    Smtp2GoAmbiguousSendError,
    Smtp2GoQuotaError,
} from '@/lib/notifications/smtp2go';

describe('SMTP2GO email client', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('sends rendered email content and returns the provider email id', async () => {
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        succeeded: 1,
                        failed: 0,
                        failures: [],
                        email_id: 'smtp2go-email-1',
                    },
                }),
                { status: 200 }
            )
        );

        await expect(
            sendSmtp2GoEmail(
                {
                    from: 'Backranq <notifications@example.com>',
                    to: 'player@example.net',
                    subject: 'Your new practice is ready',
                    html: '<p>Practice is ready.</p>',
                    text: 'Practice is ready.',
                    headers: { 'X-Backranq-Delivery-Id': 'delivery-1' },
                },
                fetchMock
            )
        ).resolves.toBe('smtp2go-email-1');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.smtp2go.com/v3/email/send',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'x-smtp2go-api-key': 'api-test',
                }),
            })
        );
        const request = fetchMock.mock.calls[0]?.[1];
        expect(JSON.parse(String(request?.body))).toMatchObject({
            sender: 'Backranq <notifications@example.com>',
            to: ['player@example.net'],
            subject: 'Your new practice is ready',
            html_body: '<p>Practice is ready.</p>',
            text_body: 'Practice is ready.',
            custom_headers: [
                { header: 'X-Backranq-Delivery-Id', value: 'delivery-1' },
            ],
        });
    });

    it('surfaces provider rejections without exposing the API key', async () => {
        vi.stubEnv('SMTP2GO_API_KEY', 'api-secret-value');
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        error_code: 'E_UNVERIFIED_SENDER',
                        error: 'Sender is not verified',
                    },
                }),
                { status: 400 }
            )
        );

        await expect(
            sendSmtp2GoEmail(
                {
                    from: 'Backranq <notifications@example.com>',
                    to: 'player@example.net',
                    subject: 'Test',
                    html: '<p>Test</p>',
                    text: 'Test',
                },
                fetchMock
            )
        ).rejects.toThrow('SMTP2GO rejected the email: Sender is not verified');
    });

    it('classifies a lost response as an ambiguous send instead of a safe retry', async () => {
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));

        await expect(
            sendSmtp2GoEmail(
                {
                    from: 'Backranq <notifications@example.com>',
                    to: 'player@example.net',
                    subject: 'Test',
                    html: '<p>Test</p>',
                    text: 'Test',
                },
                fetchMock
            )
        ).rejects.toBeInstanceOf(Smtp2GoAmbiguousSendError);
    });

    it('classifies a provider 5xx response as ambiguous', async () => {
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('upstream failure', { status: 503 })
        );

        await expect(
            sendSmtp2GoEmail(
                {
                    from: 'Backranq <notifications@example.com>',
                    to: 'player@example.net',
                    subject: 'Test',
                    html: '<p>Test</p>',
                    text: 'Test',
                },
                fetchMock
            )
        ).rejects.toBeInstanceOf(Smtp2GoAmbiguousSendError);
    });

    it('classifies an unreadable successful response as ambiguous', async () => {
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('not-json', { status: 200 })
        );

        await expect(
            sendSmtp2GoEmail(
                {
                    from: 'Backranq <notifications@example.com>',
                    to: 'player@example.net',
                    subject: 'Test',
                    html: '<p>Test</p>',
                    text: 'Test',
                },
                fetchMock
            )
        ).rejects.toBeInstanceOf(Smtp2GoAmbiguousSendError);
    });

    it('classifies a parseable but incomplete successful response as ambiguous', async () => {
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ data: { succeeded: 1 } }), {
                status: 200,
            })
        );

        await expect(
            sendSmtp2GoEmail(
                {
                    from: 'Backranq <notifications@example.com>',
                    to: 'player@example.net',
                    subject: 'Test',
                    html: '<p>Test</p>',
                    text: 'Test',
                },
                fetchMock
            )
        ).rejects.toBeInstanceOf(Smtp2GoAmbiguousSendError);
    });

    it('keeps a provider 5xx ambiguous even when its body mentions quota', async () => {
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ data: { error: 'quota service failed' } }), {
                status: 503,
            })
        );

        await expect(
            sendSmtp2GoEmail(
                {
                    from: 'Backranq <notifications@example.com>',
                    to: 'player@example.net',
                    subject: 'Test',
                    html: '<p>Test</p>',
                    text: 'Test',
                },
                fetchMock
            )
        ).rejects.toBeInstanceOf(Smtp2GoAmbiguousSendError);
    });

    it('defers quota errors until the next UTC day even with a short retry-after', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T15:00:00.000Z'));
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ data: { error: 'Daily quota reached' } }), {
                status: 429,
                headers: { 'retry-after': '60' },
            })
        );

        const error = await sendSmtp2GoEmail(
            {
                from: 'Backranq <notifications@example.com>',
                to: 'player@example.net',
                subject: 'Test',
                html: '<p>Test</p>',
                text: 'Test',
            },
            fetchMock
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Smtp2GoQuotaError);
        expect((error as Smtp2GoQuotaError).retryAt).toEqual(
            new Date('2026-08-05T00:05:00.000Z')
        );
    });
});
