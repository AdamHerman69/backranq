import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ProfileForm, type UserProfile } from '@/components/settings/ProfileForm';
import { PageHeader } from '@/components/app/PageHeader';
import { Card, CardContent } from '@/components/ui/card';

export default async function SettingsPage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/settings');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            name: true,
            image: true,
            lichessUsername: true,
            chesscomUsername: true,
        },
    });
    if (!user) redirect('/login?callbackUrl=/settings');

    const initialUser: UserProfile = {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        lichessUsername: user.lichessUsername,
        chesscomUsername: user.chesscomUsername,
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Settings"
                subtitle="Link your chess accounts so BackRank can import your games."
            />
            <Card>
                <CardContent className="pt-6">
                    <ProfileForm initialUser={initialUser} />
                </CardContent>
            </Card>
        </div>
    );
}


