export function createJsonRequest(
    url: string,
    body: unknown,
    init: RequestInit = {}
) {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');

    return new Request(url, {
        ...init,
        body: JSON.stringify(body),
        headers,
        method: init.method ?? 'POST',
    });
}

export async function readJson<T = unknown>(response: Response): Promise<T> {
    return (await response.json()) as T;
}
