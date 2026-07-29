import type { PracticeExposureWrite } from '@/lib/training/exposure';

export async function recordPracticeExposureEvent(
    event: PracticeExposureWrite
): Promise<boolean> {
    try {
        const response = await fetch('/api/training/exposures', {
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
