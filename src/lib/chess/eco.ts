import ecoCodeToNameJson from '@/lib/chess/ecoCodeToName.json';

type EcoNameRecord = Record<string, { name: string }>;

const ECO = ecoCodeToNameJson as EcoNameRecord;

export function ecoName(
    ecoCode: string | undefined | null
): string | undefined {
    const eco = (ecoCode ?? '').trim().toUpperCase();
    if (!eco) return undefined;
    const v = ECO[eco];
    return v?.name ? String(v.name) : undefined;
}
