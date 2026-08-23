import type { ReactNode } from 'react';

import { MobileBottomNav } from '@/components/nav/MobileBottomNav';

export default function OfflineAppLayout({
    children,
}: Readonly<{ children: ReactNode }>) {
    return (
        <div
            className="min-h-dvh bg-background"
            data-app-shell="true"
            data-shell-mode="workspace"
        >
            <MobileBottomNav pathname="/~offline/coach" />
            <main className="workspace-container animate-soft-enter py-3 pb-[calc(5.25rem+env(safe-area-inset-bottom))] sm:py-5 lg:py-6 lg:pb-10">
                {children}
            </main>
        </div>
    );
}
