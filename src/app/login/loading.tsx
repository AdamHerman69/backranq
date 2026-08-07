import { Skeleton } from '@/components/ui/skeleton';

export default function LoginLoading() {
    return (
        <div className="flex min-h-dvh items-center px-4 py-10 sm:px-6" role="status" aria-label="Preparing sign in">
            <div className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-[1.75rem] border border-border/70 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="hidden min-h-[34rem] bg-foreground p-10 lg:block">
                    <Skeleton className="h-8 w-28 bg-background/20" />
                    <Skeleton className="mt-36 h-8 w-4/5 bg-background/20" />
                    <Skeleton className="mt-3 h-20 w-full bg-background/20" />
                </div>
                <div className="min-h-[34rem] p-6 sm:p-10">
                    <Skeleton className="h-9 w-52" />
                    <Skeleton className="mt-3 h-12 w-full" />
                    <div className="mt-8 space-y-3">
                        <Skeleton className="h-12 w-full rounded-xl" />
                        <Skeleton className="h-12 w-full rounded-xl" />
                        <Skeleton className="h-12 w-full rounded-xl" />
                    </div>
                </div>
            </div>
            <span className="sr-only">Preparing secure sign-in options.</span>
        </div>
    );
}
