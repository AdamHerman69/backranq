import type { ProgressAnalyticsWrite } from '@/lib/progress/analytics';

export async function recordProgressEvent(
    event: ProgressAnalyticsWrite
): Promise<boolean> {
    try {
        const response = await fetch('/api/progress/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
            keepalive: true,
        });
        return response.ok;
    } catch {
        return false;
    }
}
