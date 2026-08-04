export function addUtcMonthsClamped(date: Date, months: number): Date {
    const targetMonthStart = new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth() + months,
            1,
            date.getUTCHours(),
            date.getUTCMinutes(),
            date.getUTCSeconds(),
            date.getUTCMilliseconds()
        )
    );
    const lastTargetDay = new Date(
        Date.UTC(
            targetMonthStart.getUTCFullYear(),
            targetMonthStart.getUTCMonth() + 1,
            0
        )
    ).getUTCDate();
    targetMonthStart.setUTCDate(
        Math.min(date.getUTCDate(), lastTargetDay)
    );
    return targetMonthStart;
}

export function nextMonthlyRenewAt(now: Date): Date {
    return addUtcMonthsClamped(now, 1);
}
