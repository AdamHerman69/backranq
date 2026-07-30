const ERROR_DETAIL_LIMIT_BYTES = 64_000;

export async function readBoundedResponseText(args: {
    response: Response;
    label: string;
    maxBytes: number;
}) {
    const declaredLength = Number(
        args.response.headers.get('content-length') ?? '0'
    );
    if (
        Number.isFinite(declaredLength) &&
        declaredLength > args.maxBytes
    ) {
        throw new Error(
            `${args.label} response exceeds ${args.maxBytes} bytes`
        );
    }

    const reader = args.response.body?.getReader();
    if (!reader) return '';

    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
        if (received > args.maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(
                `${args.label} response exceeds ${args.maxBytes} bytes`
            );
        }
        chunks.push(next.value);
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}

export async function readBoundedErrorDetail(
    response: Response,
    label: string
) {
    return readBoundedResponseText({
        response,
        label,
        maxBytes: ERROR_DETAIL_LIMIT_BYTES,
    }).catch(() => '');
}
