/** Shared producer/consumer schema. Execution/billing envelopes are separate. */
export const EXTRACTION_CONFIG_VERSION = 4 as const;

export function createExtractionConfigSnapshot<T>(args: {
    engine: unknown;
    extractor: T;
}) {
    return {
        version: EXTRACTION_CONFIG_VERSION,
        engine: args.engine,
        extractor: args.extractor,
    };
}
