// POST /api/auth/host/logout  — drop the temporary host session. Dev-only.

import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  HOST_SESSION_COOKIE,
  HOST_SESSION_COOKIE_PATH,
  HOST_STATE_COOKIE,
  HOST_STATE_COOKIE_PATH,
  HOST_WHISPER_COOKIE,
  HOST_WHISPER_COOKIE_PATH,
} from "@/lib/auth/host-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (process.env.NODE_ENV === "production") notFound();

  const res = NextResponse.redirect(new URL("/dev/host", env().APP_URL));
  res.cookies.delete({ name: HOST_SESSION_COOKIE, path: HOST_SESSION_COOKIE_PATH });
  res.cookies.delete({ name: HOST_STATE_COOKIE, path: HOST_STATE_COOKIE_PATH });
  res.cookies.delete({ name: HOST_WHISPER_COOKIE, path: HOST_WHISPER_COOKIE_PATH });
  return res;
}
