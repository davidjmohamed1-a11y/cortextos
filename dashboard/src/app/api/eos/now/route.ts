// POST /api/eos/now — persist the NOW card content.
//
// Body: { title: string, next_action?: string }
// Response: 200 { ok: true, now: EosNow } | 400 { error: string }
//
// Auth: dashboard session cookie (handled by the session provider higher up).
// Persistence: <ctxRoot>/state/eos/now.json via setEosNow.

import { NextRequest } from 'next/server';
import { setEosNow } from '@/lib/data/eos';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { title?: string; next_action?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const title = (body.title ?? '').trim();
  if (!title) {
    return new Response(JSON.stringify({ error: 'title required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const setBy = (session as { user?: { name?: string } })?.user?.name ?? 'david';
  const now = await setEosNow({
    title,
    next_action: (body.next_action ?? '').trim(),
    set_by: setBy,
  });
  return new Response(JSON.stringify({ ok: true, now }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
