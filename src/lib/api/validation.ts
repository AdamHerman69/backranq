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
