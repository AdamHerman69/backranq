import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSmtp2GoEmail } from '@/lib/notifications/smtp2go';

describe('SMTP2GO email client', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
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
});
