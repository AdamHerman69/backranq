import { describe, expect, it } from 'vitest';

import { readBoundedResponseText } from '@/lib/providers/boundedResponse';

describe('bounded provider responses', () => {
    it('rejects a declared oversized response before reading it', async () => {
        const response = new Response('small', {
            headers: { 'content-length': '1000' },
        });

        await expect(
            readBoundedResponseText({
                response,
                label: 'Provider games',
                maxBytes: 10,
            })
        ).rejects.toThrow('exceeds 10 bytes');
    });

    it('stops a streamed response that exceeds the byte budget', async () => {
        const response = new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('123456'));
                    controller.enqueue(new TextEncoder().encode('789012'));
                    controller.close();
                },
            })
        );

        await expect(
            readBoundedResponseText({
                response,
                label: 'Provider games',
                maxBytes: 10,
            })
        ).rejects.toThrow('exceeds 10 bytes');
    });
});
