export class LatestRequestLifecycle {
    private sequence = 0;
    private controller: AbortController | null = null;
    private scopeKey = '';

    begin(scopeKey = '') {
        this.controller?.abort();
        this.controller = new AbortController();
        this.scopeKey = scopeKey;
        const sequence = ++this.sequence;
        return {
            sequence,
            scopeKey,
            signal: this.controller.signal,
        };
    }

    isCurrent(sequence: number, scopeKey?: string) {
        return (
            sequence === this.sequence &&
            (scopeKey === undefined || scopeKey === this.scopeKey) &&
            this.controller?.signal.aborted === false
        );
    }

    cancel() {
        this.sequence += 1;
        this.controller?.abort();
        this.controller = null;
    }
}

export function isAbortError(error: unknown) {
    return (
        error instanceof DOMException
            ? error.name === 'AbortError'
            : error instanceof Error && error.name === 'AbortError'
    );
}

export function isScopedResultVisible(
    enabled: boolean,
    resultScopeKey: string,
    requestedScopeKey: string
) {
    return enabled && resultScopeKey === requestedScopeKey;
}
