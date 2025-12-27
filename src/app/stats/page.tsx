import { getCurrentUser } from '@/lib/auth/session';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { PageHeader } from '@/components/app/PageHeader';
import { Card, CardContent } from '@/components/ui/card';

export default async function StatsPage() {
    const user = await getCurrentUser();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Stats"
                subtitle={
                    <>
                        Signed in as{' '}
                        <span className="font-medium">
                            {user?.email ?? user?.name ?? 'Unknown'}
                        </span>
                    </>
                }
                actions={<SignOutButton variant="outline">Sign out</SignOutButton>}
            />

            <Card>
                <CardContent className="pt-6 text-sm text-muted-foreground">
                    Stats and analytics coming soon.
                </CardContent>
            </Card>
        </div>
    );
}

