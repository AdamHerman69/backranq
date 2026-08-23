import type { VercelRegion } from '@vercel/queue';

export const DEFAULT_BACKRANQ_QUEUE_REGION: VercelRegion = 'iad1';
const VERCEL_REGION_CODE = /^[a-z]{3}\d$/;

export function isVercelRegionCode(value: string): value is VercelRegion {
    return VERCEL_REGION_CODE.test(value);
}

export function configuredBackranqQueueRegion(
    env: Record<string, string | undefined> = process.env
): VercelRegion | null {
    const value = env.BACKRANQ_QUEUE_REGION?.trim().toLowerCase();
    return value && isVercelRegionCode(value) ? value : null;
}

export function backranqQueueRegion(
    env: Record<string, string | undefined> = process.env
): VercelRegion {
    const raw = env.BACKRANQ_QUEUE_REGION?.trim();
    const configured = configuredBackranqQueueRegion(env);
    if (raw && !configured) {
        throw new Error(
            'BACKRANQ_QUEUE_REGION must be an explicit Vercel region code such as iad1 or dub1'
        );
    }
    if (configured) return configured;
    if (env.VERCEL_ENV || env.VERCEL === '1') {
        throw new Error(
            'BACKRANQ_QUEUE_REGION is required in Vercel environments'
        );
    }
    return DEFAULT_BACKRANQ_QUEUE_REGION;
}
