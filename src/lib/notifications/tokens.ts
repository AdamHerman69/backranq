import { createHmac, timingSafeEqual } from 'node:crypto';

function secret() {
    const value =
        process.env.NOTIFICATION_UNSUBSCRIBE_SECRET ??
        process.env.NEXTAUTH_SECRET;
    if (!value) throw new Error('Notification unsubscribe secret is not configured');
    return value;
}

function signature(userId: string) {
    return createHmac('sha256', secret())
        .update(`optional-email-unsubscribe:${userId}`)
        .digest('base64url');
}

export function createUnsubscribeToken(userId: string) {
    return `${userId}.${signature(userId)}`;
}

export function verifyUnsubscribeToken(token: string) {
    const split = token.lastIndexOf('.');
    if (split <= 0) return null;
    const userId = token.slice(0, split);
    const received = Buffer.from(token.slice(split + 1));
    const expected = Buffer.from(signature(userId));
    return received.length === expected.length && timingSafeEqual(received, expected)
        ? userId
        : null;
}
