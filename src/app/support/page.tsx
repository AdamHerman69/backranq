import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
    ArrowRight,
    BookOpen,
    CircleHelp,
    CloudCog,
    CreditCard,
    Mail,
    WifiOff,
} from 'lucide-react';

import { PublicDocumentShell } from '@/app/_components/PublicDocumentShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
    title: 'Support — Backranq',
    description: 'Get help with accounts, game sync, analysis, Practice, Coach and billing.',
};

const topics = [
    {
        icon: CloudCog,
        title: 'Games and analysis',
        body: 'Check linked accounts, retry a sync and understand why a game or position may still be waiting.',
        href: '#games-analysis',
    },
    {
        icon: BookOpen,
        title: 'Practice and Coach',
        body: 'Learn how grading, review queues, local analysis and offline Coach sessions work.',
        href: '#practice-coach',
    },
    {
        icon: CreditCard,
        title: 'Plans and billing',
        body: 'Manage a subscription, understand credits or get help with a Pro invitation.',
        href: '#billing',
    },
];

export default function SupportPage() {
    return (
        <PublicDocumentShell
            eyebrow="Help center"
            title="How can we help?"
            introduction="Start with the quick checks below. If something still does not look right, send us the page, what you expected and what happened."
        >
            <section className="grid gap-3 md:grid-cols-3" aria-label="Support topics">
                {topics.map((topic) => {
                    const Icon = topic.icon;
                    return (
                        <Link
                            key={topic.title}
                            href={topic.href}
                            className="!no-underline [&_*]:!no-underline"
                        >
                            <Card className="group h-full rounded-none border-x-0 border-b border-t-2 border-t-foreground bg-transparent shadow-none transition-colors duration-300 hover:bg-muted/45">
                                <CardContent className="px-0 py-5 sm:px-4">
                                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm bg-foreground text-background">
                                        <Icon className="h-4 w-4" aria-hidden="true" />
                                    </span>
                                    <h2 className="mt-4 font-display text-xl">{topic.title}</h2>
                                    <p className="mt-2 text-sm leading-6">{topic.body}</p>
                                    <ArrowRight className="mt-4 h-4 w-4 text-foreground transition-transform group-hover:translate-x-1.5" aria-hidden="true" />
                                </CardContent>
                            </Card>
                        </Link>
                    );
                })}
            </section>

            <section id="games-analysis" className="scroll-mt-24 space-y-4">
                <h2>Games and analysis</h2>
                <Faq question="Why are my newest games missing?">
                    Confirm the correct public username under Settings, then open Games and use Sync. Provider delays and rate limits can postpone a sync without removing games already in your library.
                </Faq>
                <Faq question="Why is a game not producing Practice positions?">
                    The game needs current analysis and a stable, meaningful decision that passes Backranq&apos;s verification. A completed analysis can legitimately produce no saved position.
                </Faq>
                <Faq question="Can I analyze without server credits?">
                    Yes. Browser analysis runs locally while the tab stays open. Server analysis can continue after you leave and may use plan credits or limits.
                </Faq>
                <Button asChild variant="outline" className="min-h-11 no-underline">
                    <Link href="/games">Open Games</Link>
                </Button>
            </section>

            <section id="practice-coach" className="scroll-mt-24 space-y-4">
                <h2>Practice and Coach</h2>
                <Faq question="How is my Practice move graded?">
                    Backranq compares the move with verified engine evidence for that exact position. Good alternatives can be accepted even when they differ from the move played in the source game.
                </Faq>
                <Faq question="What happens when grading cannot finish?">
                    Your legal move is not silently marked wrong. Backranq shows an unresolved state and lets you retry local analysis or reveal the verified line where available.
                </Faq>
                <Faq question="How does offline Coach work?">
                    Open Play online once to prepare the engine and device access. The active game is saved locally. When you reconnect, completed games can be saved and analyzed in your library.
                </Faq>
                <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" className="min-h-11 no-underline">
                        <Link href="/practice">Open Practice</Link>
                    </Button>
                    <Button asChild variant="outline" className="min-h-11 no-underline">
                        <Link href="/play">Open Coach</Link>
                    </Button>
                </div>
            </section>

            <section id="billing" className="scroll-mt-24 space-y-4">
                <h2>Plans and billing</h2>
                <Faq question="Where can I manage my subscription?">
                    Open Settings and go to Plan & billing. If your plan is managed by Stripe, the billing portal lets you update payment details or cancel future renewal.
                </Faq>
                <Faq question="My Pro invitation does not work. What should I check?">
                    Sign in with the exact invited email address. Invitation links can expire or be replaced when resent; ask the sender for the newest link.
                </Faq>
                <Button asChild variant="outline" className="min-h-11 no-underline">
                    <Link href="/settings#billing">Open billing settings</Link>
                </Button>
            </section>

            <section className="border-y border-border bg-foreground p-5 text-background sm:p-7" aria-labelledby="contact-support-title">
                <div className="flex gap-4">
                    <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-accent text-accent-foreground">
                        <Mail className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                        <h2 id="contact-support-title">Still stuck?</h2>
                        <p className="mt-2 text-background/70 [&_a]:text-background">
                            Email <a href="mailto:support@backranq.com">support@backranq.com</a>. Include the affected page, your chess provider, approximate time and a screenshot if possible. Never send a password or payment-card number.
                        </p>
                        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-background/65">
                            <span className="inline-flex items-center gap-2"><CircleHelp className="h-4 w-4" aria-hidden="true" /> Account and product help</span>
                            <span className="inline-flex items-center gap-2"><WifiOff className="h-4 w-4" aria-hidden="true" /> Offline troubleshooting</span>
                        </div>
                    </div>
                </div>
            </section>
        </PublicDocumentShell>
    );
}

function Faq({ question, children }: { question: string; children: ReactNode }) {
    return (
        <details className="group border-b border-border bg-transparent px-0 py-3">
            <summary className="flex min-h-11 cursor-pointer list-none items-center font-medium text-foreground marker:hidden">
                <span className="flex items-center justify-between gap-4">
                    {question}
                    <span className="text-lg font-normal text-muted-foreground transition-transform group-open:rotate-45" aria-hidden="true">+</span>
                </span>
            </summary>
            <p className="mt-3 border-t border-border/60 pt-3 text-sm leading-6">{children}</p>
        </details>
    );
}
