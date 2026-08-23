export class MasterSourceProviderError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'MasterSourceProviderError';
    }
}
