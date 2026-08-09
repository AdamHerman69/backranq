'use client';

import { useCallback, useRef, type TouchEvent } from 'react';
import type { Square } from 'chess.js';

type TouchGesture = {
    x: number;
    y: number;
    maximumTravel: number;
};

const TAP_MOVEMENT_TOLERANCE_PX = 12;
const SQUARE_PATTERN = /^[a-h][1-8]$/;

export function useReliableBoardTouch({
    enabled,
    onTap,
}: {
    enabled: boolean;
    onTap: (square: Square) => void;
}) {
    const gestureRef = useRef<TouchGesture | null>(null);

    const onTouchStartCapture = useCallback(
        (event: TouchEvent<HTMLElement>) => {
            if (!enabled || event.touches.length !== 1) {
                gestureRef.current = null;
                return;
            }
            const touch = event.touches.item(0);
            if (!touch) return;
            gestureRef.current = {
                x: touch.clientX,
                y: touch.clientY,
                maximumTravel: 0,
            };
        },
        [enabled]
    );

    const onTouchMoveCapture = useCallback(
        (event: TouchEvent<HTMLElement>) => {
            const gesture = gestureRef.current;
            const touch = event.touches.item(0);
            if (!gesture || !touch) return;
            gesture.maximumTravel = Math.max(
                gesture.maximumTravel,
                Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y)
            );
        },
        []
    );

    const onTouchEndCapture = useCallback(
        (event: TouchEvent<HTMLElement>) => {
            const gesture = gestureRef.current;
            gestureRef.current = null;
            if (!enabled || !gesture) return;

            const touch = event.changedTouches.item(0);
            if (!touch) return;
            const totalTravel = Math.max(
                gesture.maximumTravel,
                Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y)
            );
            if (totalTravel > TAP_MOVEMENT_TOLERANCE_PX) return;

            const target = document.elementFromPoint(
                touch.clientX,
                touch.clientY
            );
            const square = target
                ?.closest<HTMLElement>('[data-square]')
                ?.dataset.square;
            if (!square || !SQUARE_PATTERN.test(square)) return;

            event.preventDefault();
            event.stopPropagation();
            onTap(square as Square);
        },
        [enabled, onTap]
    );

    const onTouchCancelCapture = useCallback(() => {
        gestureRef.current = null;
    }, []);

    return {
        onTouchStartCapture,
        onTouchMoveCapture,
        onTouchEndCapture,
        onTouchCancelCapture,
    };
}
