'use client';

import type { ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
    validateAnalysisNumericPreference,
    type AnalysisDefaults,
    type AnalysisNumericPreferenceKey,
} from '@/lib/preferences';
import type {
    TrainingCoveragePreset,
    TrainingGradingTolerance,
} from '@/lib/training/config';

export const TRAINING_COVERAGE_OPTION_LABELS: Record<
    TrainingCoveragePreset,
    string
> = {
    ALL_CONFIRMED: 'Nearly every confirmed moment',
    BALANCED: 'Meaningful moments',
    HIGH_CONFIDENCE: 'Major moments only',
};

const NUMERIC_FIELD_COPY: Record<
    AnalysisNumericPreferenceKey,
    { label: string; hint: string; error: string }
> = {
    analysisNodesPerPosition: {
        label: 'Nodes per position',
        hint: 'Deterministic work budget used while scanning each decision.',
        error: 'Enter a whole number from 1,000 to 10,000,000.',
    },
    confirmationNodes: {
        label: 'Confirmation nodes',
        hint: 'Stronger second pass for candidates. Leave blank to disable it.',
        error: 'Leave blank or enter a whole number from 1,000 to 20,000,000.',
    },
    themeLookaheadPlies: {
        label: 'Theme lookahead (plies)',
        hint: 'Used only for explanation tags; it never filters a training moment.',
        error: 'Enter a whole number from 0 to 32.',
    },
};

function Field({
    label,
    hint,
    error,
    children,
}: {
    label: string;
    hint: string;
    error?: string | null;
    children: ReactNode;
}) {
    return (
        <label className="space-y-1">
            <div className="text-sm font-medium">{label}</div>
            {children}
            <div
                className={cn(
                    'text-xs',
                    error ? 'text-destructive' : 'text-muted-foreground'
                )}
                aria-live={error ? 'polite' : undefined}
            >
                {error ?? hint}
            </div>
        </label>
    );
}

function IntentSetting({
    title,
    description,
    children,
    dense,
}: {
    title: string;
    description: string;
    children: ReactNode;
    dense: boolean;
}) {
    return (
        <section
            className={cn(
                'rounded-lg border bg-muted/20',
                dense ? 'space-y-2 p-2.5' : 'space-y-3 p-3'
            )}
        >
            <div>
                <div className="text-sm font-semibold">{title}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                    {description}
                </p>
            </div>
            {children}
        </section>
    );
}

export function analysisDefaultsAreValid(value: AnalysisDefaults): boolean {
    return (
        validateAnalysisNumericPreference(
            'analysisNodesPerPosition',
            value.analysisNodesPerPosition
        ) &&
        validateAnalysisNumericPreference(
            'confirmationNodes',
            value.confirmationNodes
        ) &&
        validateAnalysisNumericPreference(
            'themeLookaheadPlies',
            value.themeLookaheadPlies
        )
    );
}

export function AnalysisDefaultsFields({
    value,
    onChange,
    disabled,
    dense = false,
}: {
    value: AnalysisDefaults;
    onChange: (next: AnalysisDefaults) => void;
    disabled?: boolean;
    dense?: boolean;
}) {
    function patch(next: Partial<AnalysisDefaults>) {
        onChange({ ...value, ...next });
    }

    function numericError(key: AnalysisNumericPreferenceKey) {
        return validateAnalysisNumericPreference(key, value[key])
            ? null
            : NUMERIC_FIELD_COPY[key].error;
    }

    return (
        <div className={cn(dense ? 'space-y-3' : 'space-y-4')}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <IntentSetting
                    title="Training moments to keep"
                    description="Coverage controls which confirmed decisions become training moments."
                    dense={dense}
                >
                    <Field
                        label="Training coverage"
                        hint="Includes your mistakes and missed opportunities when a game is analyzed again."
                    >
                        <Select
                            value={value.trainingCoveragePreset}
                            onValueChange={(trainingCoveragePreset) =>
                                patch({
                                    trainingCoveragePreset:
                                        trainingCoveragePreset as TrainingCoveragePreset,
                                })
                            }
                            disabled={disabled}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="ALL_CONFIRMED">
                                    {
                                        TRAINING_COVERAGE_OPTION_LABELS.ALL_CONFIRMED
                                    }
                                </SelectItem>
                                <SelectItem value="BALANCED">
                                    {TRAINING_COVERAGE_OPTION_LABELS.BALANCED}
                                </SelectItem>
                                <SelectItem value="HIGH_CONFIDENCE">
                                    {
                                        TRAINING_COVERAGE_OPTION_LABELS.HIGH_CONFIDENCE
                                    }
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                </IntentSetting>

                <IntentSetting
                    title="Moves to accept"
                    description="Tolerance grades your answer; it never removes saved training moments."
                    dense={dense}
                >
                    <Field
                        label="Accepted-move tolerance"
                        hint="Moves are judged by practical outcome, not exact engine equality."
                    >
                        <Select
                            value={value.trainingGradingTolerance}
                            onValueChange={(trainingGradingTolerance) =>
                                patch({
                                    trainingGradingTolerance:
                                        trainingGradingTolerance as TrainingGradingTolerance,
                                })
                            }
                            disabled={disabled}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="STRICT">Strict</SelectItem>
                                <SelectItem value="PRACTICAL">
                                    Practical
                                </SelectItem>
                                <SelectItem value="LENIENT">Lenient</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                </IntentSetting>
            </div>

            <details className="group rounded-lg border">
                <summary className="cursor-pointer list-none rounded-lg px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center justify-between gap-3">
                        <span>
                            <span className="block text-sm font-medium">
                                Advanced analysis
                            </span>
                            <span className="block text-xs text-muted-foreground">
                                Engine budgets and explanation tagging
                            </span>
                        </span>
                        <span
                            aria-hidden="true"
                            className="text-muted-foreground transition-transform group-open:rotate-180"
                        >
                            ▾
                        </span>
                    </span>
                </summary>

                <div
                    className={cn(
                        'grid grid-cols-1 gap-3 border-t',
                        dense
                            ? 'p-2.5 md:grid-cols-3'
                            : 'p-3 md:grid-cols-3'
                    )}
                >
                    {(
                        [
                            'analysisNodesPerPosition',
                            'confirmationNodes',
                            'themeLookaheadPlies',
                        ] as const
                    ).map((key) => {
                        const copy = NUMERIC_FIELD_COPY[key];
                        const error = numericError(key);
                        return (
                            <Field
                                key={key}
                                label={copy.label}
                                hint={copy.hint}
                                error={error}
                            >
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    value={value[key]}
                                    onChange={(event) =>
                                        patch({ [key]: event.target.value })
                                    }
                                    disabled={disabled}
                                    min={
                                        key === 'themeLookaheadPlies'
                                            ? 0
                                            : 1_000
                                    }
                                    max={
                                        key === 'analysisNodesPerPosition'
                                            ? 10_000_000
                                            : key === 'confirmationNodes'
                                              ? 20_000_000
                                              : 32
                                    }
                                    step={1}
                                    required={key !== 'confirmationNodes'}
                                    aria-invalid={error ? true : undefined}
                                />
                            </Field>
                        );
                    })}
                </div>
            </details>

            {dense ? null : (
                <p className="text-xs text-muted-foreground">
                    New grading tolerances are stored in each solution
                    revision, so historical attempts keep their original
                    policy.
                </p>
            )}
        </div>
    );
}
