import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const needsAuth = path.startsWith("/dashboard") || path.startsWith("/agent");
  const hasSession = Boolean(request.cookies.get("numeriqu_access_token")?.value);

  if (!hasSession && needsAuth) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (hasSession && (path === "/login" || path === "/signup")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/agent/:path*", "/login", "/signup"],
};

