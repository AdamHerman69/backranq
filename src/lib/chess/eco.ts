import ecoCodeToNameJson from '@/lib/chess/ecoCodeToName.json';
import type { OpeningInfo } from '@/lib/chess/opening';

type EcoNameRecord = Record<string, { name: string }>;

const ECO = ecoCodeToNameJson as EcoNameRecord;

export function ecoName(
    ecoCode: string | undefined | null | OpeningInfo
): string | undefined {
    const raw =
        typeof ecoCode === 'string'
            ? ecoCode
            : ecoCode && typeof ecoCode === 'object'
            ? ecoCode.eco ?? ''
            : '';
    const eco = String(raw ?? '')
        .trim()
        .toUpperCase();
    if (!eco) return undefined;
    const v = ECO[eco];
    return v?.name ? String(v.name) : undefined;
}
