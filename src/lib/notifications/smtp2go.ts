const SMTP2GO_SEND_URL = 'https://api.smtp2go.com/v3/email/send';
const SMTP2GO_TIMEOUT_MS = 15_000;

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

    const response = await fetchImplementation(SMTP2GO_SEND_URL, {
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
    const raw = await response.text();
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
