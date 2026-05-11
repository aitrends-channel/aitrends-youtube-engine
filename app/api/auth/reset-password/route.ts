import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();

  const authApiUrl = process.env.AUTH_API_URL;
  if (!authApiUrl) {
    return NextResponse.json({ error: "Auth API not configured" }, { status: 500 });
  }

  const res = await fetch(`${authApiUrl}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
