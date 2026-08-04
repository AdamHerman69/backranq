const SMTP2GO_SEND_URL = 'https://api.smtp2go.com/v3/email/send';
const SMTP2GO_TIMEOUT_MS = 15_000;

export class Smtp2GoAmbiguousSendError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'Smtp2GoAmbiguousSendError';
    }
}

export class Smtp2GoQuotaError extends Error {
    readonly retryAt: Date;

    constructor(message: string, retryAt: Date) {
        super(message);
        this.name = 'Smtp2GoQuotaError';
        this.retryAt = retryAt;
    }
}

export type Smtp2GoEmail = {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
};

type Smtp2GoResponse = {
    data?: {
        succeeded?: number;
        failed?: number;
        failures?: unknown[];
        email_id?: string;
        error?: string;
        error_code?: string;
    };
};

export async function sendSmtp2GoEmail(
    email: Smtp2GoEmail,
    fetchImplementation: typeof fetch = fetch
) {
    const apiKey = process.env.SMTP2GO_API_KEY;
    if (!apiKey) throw new Error('SMTP2GO_API_KEY is not configured');

    let response: Response;
    try {
        response = await fetchImplementation(SMTP2GO_SEND_URL, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-smtp2go-api-key': apiKey,
            },
            body: JSON.stringify({
                sender: email.from,
                to: [email.to],
                subject: email.subject,
                html_body: email.html,
                text_body: email.text,
                custom_headers: Object.entries(email.headers ?? {}).map(
                    ([header, value]) => ({ header, value })
                ),
            }),
            signal: AbortSignal.timeout(SMTP2GO_TIMEOUT_MS),
        });
    } catch (error) {
        throw new Smtp2GoAmbiguousSendError(
            'SMTP2GO request ended without a response; delivery state is unknown',
            { cause: error }
        );
    }

    let raw: string;
    try {
        raw = await response.text();
    } catch (error) {
        throw new Smtp2GoAmbiguousSendError(
            'SMTP2GO response could not be read; delivery state is unknown',
            { cause: error }
        );
    }
    let payload: Smtp2GoResponse | null = null;
    try {
        payload = JSON.parse(raw) as Smtp2GoResponse;
    } catch {
        // The status and bounded excerpt below provide a useful provider error.
    }
    const providerError =
        payload?.data?.error ??
        payload?.data?.error_code ??
        (!response.ok ? raw.slice(0, 500) : null);
    const emailId = payload?.data?.email_id;
    if (response.status === 408 || response.status >= 500) {
        throw new Smtp2GoAmbiguousSendError(
            'SMTP2GO returned an ambiguous response; delivery state is unknown'
        );
    }
    if (
        response.status === 429 ||
        (providerError && /quota|rate[ -]?limit|daily limit/i.test(providerError))
    ) {
        throw new Smtp2GoQuotaError(
            providerError
                ? `SMTP2GO quota exceeded: ${providerError}`
                : 'SMTP2GO quota exceeded',
            nextUtcDay(response.headers.get('retry-after'))
        );
    }
    const explicitFailure = !!payload?.data?.failed || !!providerError;
    if (
        response.ok &&
        (!payload ||
            (!explicitFailure &&
                (payload.data?.succeeded !== 1 || !emailId)))
    ) {
        throw new Smtp2GoAmbiguousSendError(
            'SMTP2GO returned an ambiguous response; delivery state is unknown'
        );
    }
    if (
        !response.ok ||
        payload?.data?.failed ||
        payload?.data?.succeeded !== 1 ||
        !emailId
    ) {
        throw new Error(
            providerError
                ? `SMTP2GO rejected the email: ${providerError}`
                : 'SMTP2GO returned no email id'
        );
    }
    return emailId;
}

function nextUtcDay(retryAfter: string | null) {
    const now = new Date();
    const tomorrow = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)
    );
    if (!retryAfter) return tomorrow;
    const seconds = Number(retryAfter);
    const providerRetry = Number.isFinite(seconds)
        ? new Date(now.getTime() + Math.max(0, seconds) * 1_000)
        : new Date(retryAfter);
    return Number.isNaN(providerRetry.getTime()) || providerRetry < tomorrow
        ? tomorrow
        : providerRetry;
}
