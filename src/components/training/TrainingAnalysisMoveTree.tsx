'use client';

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { GitBranch, MoreHorizontal, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    trainingAnalysisActiveMoveStyle,
    trainingAnalysisTreeStyle,
} from '@/components/training/trainingAnalysisPalette';
import {
    deletableTrainingAnalysisNodeIds,
    trainingAnalysisPly,
    trainingAnalysisPositionContext,
    type TrainingAnalysisNode,
    type TrainingAnalysisNodeTag,
    type TrainingAnalysisPositionContext,
    type TrainingAnalysisTree,
} from '@/lib/training/analysisTree';
import { cn } from '@/lib/utils';

const TAG_LABELS: Partial<Record<TrainingAnalysisNodeTag, string>> = {
    DECISION: 'Decision',
    YOUR_MOVE: 'You',
    GAME_MOVE: 'Game',
    BEST_LINE: 'Best',
};

function MoveButton({
    node,
    parent,
    active,
    mainLine,
    canDelete,
    context,
    onJump,
    onPromote,
    onDelete,
}: {
    node: TrainingAnalysisNode;
    parent: TrainingAnalysisNode;
    active: boolean;
    mainLine: boolean;
    canDelete: boolean;
    context: TrainingAnalysisPositionContext;
    onJump: (nodeId: string) => void;
    onPromote: (nodeId: string) => void;
    onDelete: (nodeId: string) => void;
}) {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const ply = trainingAnalysisPly(parent);
    const moveNumber = Math.floor(ply / 2) + 1;
    const prefix = ply % 2 === 0 ? `${moveNumber}.` : `${moveNumber}...`;
    const labels = node.tags
        .filter(
            (tag) =>
                tag !== 'BEST_LINE' ||
                !parent.tags.includes('BEST_LINE')
        )
        .map((tag) => TAG_LABELS[tag])
        .filter((label): label is string => Boolean(label));

    useEffect(() => {
        if (!active) return;
        buttonRef.current?.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
        });
    }, [active]);

    return (
        <span
            className={cn(
                'inline-flex items-center gap-0.5 rounded-md',
                active && 'text-foreground'
            )}
        >
            <button
                ref={buttonRef}
                type="button"
                className={cn(
                    'inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'text-foreground',
                    !mainLine && !active && 'text-muted-foreground'
                )}
                style={
                    active
                        ? trainingAnalysisActiveMoveStyle(context)
                        : undefined
                }
                onClick={() => onJump(node.id)}
                aria-current={active ? 'step' : undefined}
                aria-label={`${prefix} ${node.moveSan ?? node.moveUci ?? 'move'}${labels.length > 0 ? `, ${labels.join(', ')}` : ''}`}
                data-analysis-node-id={node.id}
                data-analysis-move-uci={node.moveUci ?? undefined}
            >
                <span
                    className={cn(
                        'text-[11px]',
                        active
                            ? 'text-foreground/65'
                            : 'text-muted-foreground'
                    )}
                    aria-hidden="true"
                >
                    {prefix}
                </span>
                <span>{node.moveSan ?? node.moveUci ?? '—'}</span>
                {labels.map((label) => (
                    <Badge
                        key={label}
                        variant={active ? 'outline' : 'secondary'}
                        className={cn(
                            'h-4 px-1 text-[9px] leading-none',
                            active &&
                                'border-foreground/20 text-foreground'
                        )}
                    >
                        {label}
                    </Badge>
                ))}
            </button>

            {active && (canDelete || !mainLine) ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className={cn(
                                'h-8 w-7',
                                active &&
                                    'text-foreground hover:bg-foreground/5 hover:text-foreground'
                            )}
                            aria-label={`Actions for ${node.moveSan ?? node.moveUci ?? 'move'}`}
                        >
                            <MoreHorizontal className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {!mainLine ? (
                            <DropdownMenuItem
                                onSelect={() => onPromote(node.id)}
                            >
                                <GitBranch className="h-4 w-4" />
                                Make main line
                            </DropdownMenuItem>
                        ) : null}
                        {canDelete ? (
                            <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => onDelete(node.id)}
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete variation
                            </DropdownMenuItem>
                        ) : null}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
        </span>
    );
}

function VariationSequence({
    tree,
    startId,
    depth,
    onJump,
    onPromote,
    onDelete,
    deletableNodeIds,
}: {
    tree: TrainingAnalysisTree;
    startId: string;
    depth: number;
    onJump: (nodeId: string) => void;
    onPromote: (nodeId: string) => void;
    onDelete: (nodeId: string) => void;
    deletableNodeIds: ReadonlySet<string>;
}) {
    const content: ReactNode[] = [];
    let nodeId: string | undefined = startId;
    let remaining = Object.keys(tree.nodes).length;

    while (nodeId && remaining > 0) {
        remaining -= 1;
        const node: TrainingAnalysisNode | undefined = tree.nodes[nodeId];
        const parent = node?.parentId ? tree.nodes[node.parentId] : null;
        if (!node || !parent) break;
        const mainLine = parent.childrenIds[0] === node.id;
        const context = trainingAnalysisPositionContext(tree, node.id);
        content.push(
            <MoveButton
                key={node.id}
                node={node}
                parent={parent}
                active={node.id === tree.cursorId}
                mainLine={mainLine}
                canDelete={deletableNodeIds.has(node.id)}
                context={context}
                onJump={onJump}
                onPromote={onPromote}
                onDelete={onDelete}
            />
        );

        for (const variationId of node.childrenIds.slice(1)) {
            content.push(
                <div
                    key={`variation-${variationId}`}
                    className="basis-full border-l-2 border-muted-foreground/25 pl-2"
                    style={{ marginLeft: `${Math.min(depth, 6) * 0.35}rem` }}
                >
                    <VariationSequence
                        tree={tree}
                        startId={variationId}
                        depth={depth + 1}
                        onJump={onJump}
                        onPromote={onPromote}
                        onDelete={onDelete}
                        deletableNodeIds={deletableNodeIds}
                    />
                </div>
            );
        }
        nodeId = node.childrenIds[0];
    }

    return <div className="flex flex-wrap items-center gap-1">{content}</div>;
}

export function TrainingAnalysisMoveTree({
    tree,
    onJump,
    onPromote,
    onDelete,
}: {
    tree: TrainingAnalysisTree;
    onJump: (nodeId: string) => void;
    onPromote: (nodeId: string) => void;
    onDelete: (nodeId: string) => void;
}) {
    const root = tree.nodes[tree.rootId];
    const deletableNodeIds = useMemo(
        () => deletableTrainingAnalysisNodeIds(tree),
        [tree]
    );
    const cursorContext = trainingAnalysisPositionContext(tree);
    if (!root) return null;

    return (
        <div
            className="max-h-64 overflow-auto rounded-lg border bg-muted/15 p-3"
            aria-label="Analysis move tree"
            data-analysis-position-context={cursorContext}
            style={trainingAnalysisTreeStyle(cursorContext)}
        >
            {root.childrenIds.length > 0 ? (
                <>
                    <VariationSequence
                        tree={tree}
                        startId={root.childrenIds[0]!}
                        depth={0}
                        onJump={onJump}
                        onPromote={onPromote}
                        onDelete={onDelete}
                        deletableNodeIds={deletableNodeIds}
                    />
                    {root.childrenIds.slice(1).map((variationId) => (
                        <div
                            key={variationId}
                            className="mt-1 border-l-2 border-muted-foreground/25 pl-2"
                        >
                            <VariationSequence
                                tree={tree}
                                startId={variationId}
                                depth={1}
                                onJump={onJump}
                                onPromote={onPromote}
                                onDelete={onDelete}
                                deletableNodeIds={deletableNodeIds}
                            />
                        </div>
                    ))}
                </>
            ) : (
                <p className="text-sm text-muted-foreground">
                    Play a move on the board to start a variation.
                </p>
            )}
        </div>
    );
}
