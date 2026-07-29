export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: string; status?: number };

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(
    value: unknown,
    field: string,
    opts: { required?: boolean; maxLength?: number } = {}
): ValidationResult<string | undefined> {
    if (value == null) {
        return opts.required
            ? { ok: false, error: `Missing ${field}` }
            : { ok: true, value: undefined };
    }
    if (typeof value !== 'string') {
        return { ok: false, error: `Invalid ${field}` };
    }
    const trimmed = value.trim();
    if (opts.required && !trimmed) {
        return { ok: false, error: `Missing ${field}` };
    }
    if (opts.maxLength && trimmed.length > opts.maxLength) {
        return { ok: false, error: `${field} is too long`, status: 413 };
    }
    return { ok: true, value: trimmed };
}

export function stringArrayValue(
    value: unknown,
    field: string,
    opts: { maxItems: number; maxLength?: number; dedupe?: boolean }
): ValidationResult<string[]> {
    if (!Array.isArray(value)) {
        return { ok: false, error: `Invalid ${field}` };
    }
    if (value.length > opts.maxItems) {
        return {
            ok: false,
            error: `${field} exceeds limit of ${opts.maxItems}`,
            status: 413,
        };
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < value.length; i += 1) {
        const parsed = stringValue(value[i], `${field}[${i}]`, {
            required: true,
            maxLength: opts.maxLength,
        });
        if (!parsed.ok) return parsed;
        const item = parsed.value;
        if (!item) return { ok: false, error: `Invalid ${field}[${i}]` };
        if (opts.dedupe) {
            if (seen.has(item)) continue;
            seen.add(item);
        }
        out.push(item);
    }
    return { ok: true, value: out };
}

export function jsonError(error: string) {
    return { error };
}

export async function boundedJsonBody(
    req: Request,
    maxBytes: number
): Promise<ValidationResult<unknown>> {
    const declaredLength = Number(req.headers.get('content-length') ?? '0');
    if (
        Number.isFinite(declaredLength) &&
        declaredLength > 0 &&
        declaredLength > maxBytes
    ) {
        return {
            ok: false,
            error: `Request exceeds limit of ${maxBytes} bytes`,
            status: 413,
        };
    }

    const text = await req.text().catch(() => null);
    if (text == null) return { ok: false, error: 'Invalid JSON body' };
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return {
            ok: false,
            error: `Request exceeds limit of ${maxBytes} bytes`,
            status: 413,
        };
    }

    try {
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
        return { ok: false, error: 'Invalid JSON body' };
    }
}

const ISO_INSTANT_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isStrictIsoInstant(value: unknown): value is string {
    if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime());
}

export function isStrictIsoDate(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const match = ISO_DATE_RE.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
    );
}
