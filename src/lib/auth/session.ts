import { auth } from './index';

export async function getCurrentUser() {
    const session = await auth();
    return session?.user ?? null;
}
