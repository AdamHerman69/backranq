export const EXPECTED_OWNER_HEADER = 'X-Backranq-Owner-Id';

export function expectedOwnerId(request: Request) {
    return request.headers.get(EXPECTED_OWNER_HEADER)?.trim() ?? '';
}
