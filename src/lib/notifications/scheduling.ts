export function practiceReadyDeliveryWindow(
    now: Date,
    timezone: string,
    hour: number
) {
    const scheduledFor = nextDigestAt(now, timezone, hour, 'DAILY');
    return {
        scheduledFor,
        key: scheduledFor.toISOString(),
    };
}

export function digestPeriodKey(
    now: Date,
    frequency: 'OFF' | 'DAILY' | 'WEEKLY',
    timezone: string
) {
    const local = zonedParts(now, timezone);
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
    if (frequency !== 'WEEKLY') return date.toISOString().slice(0, 10);
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - weekday + 1);
    return date.toISOString().slice(0, 10);
}

export function nextDigestAt(
    now: Date,
    timezone: string,
    hour: number,
    frequency: 'DAILY' | 'WEEKLY'
) {
    const local = zonedParts(now, timezone);
    const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
    if (frequency === 'WEEKLY') {
        const weekday = localDate.getUTCDay() || 7;
        localDate.setUTCDate(localDate.getUTCDate() + (8 - weekday) % 7);
    }
    let candidate = localTimeToUtc(localDate, hour, timezone);
    if (candidate <= now) {
        localDate.setUTCDate(
            localDate.getUTCDate() + (frequency === 'DAILY' ? 1 : 7)
        );
        candidate = localTimeToUtc(localDate, hour, timezone);
    }
    return candidate;
}

function zonedParts(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value);
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
    };
}

function localTimeToUtc(localDate: Date, hour: number, timezone: string) {
    let candidate = new Date(
        Date.UTC(
            localDate.getUTCFullYear(),
            localDate.getUTCMonth(),
            localDate.getUTCDate(),
            hour
        )
    );
    for (let index = 0; index < 2; index += 1) {
        const actual = zonedParts(candidate, timezone);
        const wantedMs = Date.UTC(
            localDate.getUTCFullYear(),
            localDate.getUTCMonth(),
            localDate.getUTCDate(),
            hour
        );
        const actualMs = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour
        );
        candidate = new Date(candidate.getTime() + wantedMs - actualMs);
    }
    return candidate;
}
