export type OwnerEpoch = {
    ownerId: string | null;
    generation: number;
};

export type OwnerRunToken = {
    ownerId: string;
    generation: number;
};

export function advanceOwnerEpoch(
    current: OwnerEpoch,
    nextOwnerId: string | null
): OwnerEpoch {
    if (current.ownerId === nextOwnerId) return current;
    return {
        ownerId: nextOwnerId,
        generation: current.generation + 1,
    };
}

export function captureOwnerRun(epoch: OwnerEpoch): OwnerRunToken | null {
    if (!epoch.ownerId) return null;
    return {
        ownerId: epoch.ownerId,
        generation: epoch.generation,
    };
}

export function isOwnerRunCurrent(
    token: OwnerRunToken,
    epoch: OwnerEpoch
): boolean {
    return (
        token.ownerId === epoch.ownerId &&
        token.generation === epoch.generation
    );
}
