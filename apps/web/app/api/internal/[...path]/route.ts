import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getTargetBase(): string {
  const target =
    process.env.API_PROXY_TARGET?.trim() ||
    process.env.API_INTERNAL_URL?.trim() ||
    "http://127.0.0.1:3000";
  return target.replace(/\/$/, "");
}

function buildUpstreamUrl(pathname: string, search: string) {
  const base = getTargetBase();
  const cleanPath = pathname.replace(/^\/api\/internal/, "");
  return `${base}${cleanPath}${search || ""}`;
}

async function proxy(request: Request) {
  const url = new URL(request.url);
  const upstream = buildUpstreamUrl(url.pathname, url.search);

  const headers = new Headers(request.headers);
  // Avoid compressing twice and prevent hop-by-hop header issues.
  headers.delete("host");
  // If the client didn't set an explicit org header, try to infer it from the cookie.
  if (!headers.has("x-organization-id")) {
    const cookie = headers.get("cookie") || "";
    const match = cookie.match(/(?:^|;\s*)nq_organization_id=([^;]+)/);
    if (match?.[1]) {
      try {
        headers.set("x-organization-id", decodeURIComponent(match[1]));
      } catch {
        headers.set("x-organization-id", match[1]);
      }
    }
  }

  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });

  const outHeaders = new Headers(response.headers);
  // Let Next set content-length.
  outHeaders.delete("content-length");

  return new NextResponse(response.body, {
    status: response.status,
    headers: outHeaders,
  });
}

export async function GET(request: Request) {
  return proxy(request);
}
export async function POST(request: Request) {
  return proxy(request);
}
export async function PATCH(request: Request) {
  return proxy(request);
}
export async function PUT(request: Request) {
  return proxy(request);
}
export async function DELETE(request: Request) {
  return proxy(request);
}
