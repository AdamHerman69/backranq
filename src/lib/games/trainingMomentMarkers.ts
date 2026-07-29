export const GAME_TRAINING_MOMENT_MARKER_SELECT = {
    id: true,
    decisionPly: true,
} as const;

export type GameTrainingMomentMarker = {
    id: string;
    decisionPly: number;
};
