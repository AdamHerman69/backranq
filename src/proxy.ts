import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export async function proxy(req: NextRequest) {
    // Auth.js v5 (and NextAuth v4) store a session token cookie.
    // When using a DB-backed session strategy, this cookie is NOT a JWT, so we
    // can't validate it in Edge without DB access. Presence is enough to allow
    // navigation; server-side pages/routes will enforce validity.
    const hasSessionCookie =
        req.cookies.has('authjs.session-token') ||
        req.cookies.has('__Secure-authjs.session-token') ||
        req.cookies.has('next-auth.session-token') ||
        req.cookies.has('__Secure-next-auth.session-token');

    if (hasSessionCookie) return NextResponse.next();

    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set(
        'callbackUrl',
        `${req.nextUrl.pathname}${req.nextUrl.search}`
    );
    return NextResponse.redirect(url);
}

export const config = {
    matcher: [
        '/stats/:path*',
        '/games/:path*',
        '/puzzles/:path*',
        '/settings/:path*',
        '/profile/:path*',
        '/insights/:path*',
    ],
};
