export class ExactPvUnavailableError extends Error {
    constructor() {
        super('Engine returned no exact PV');
        this.name = 'ExactPvUnavailableError';
    }
}
