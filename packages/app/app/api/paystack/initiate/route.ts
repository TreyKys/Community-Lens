import { NextResponse } from 'next/server';

// Paystack integration was scrapped per board decision — Squad is the only
// active provider. Returning 410 Gone so any stale client that still posts
// here gets a clear, actionable signal instead of a silent 404.
export async function POST() {
  return NextResponse.json(
    { error: 'Paystack is no longer supported. Please retry — you will be routed through Squad.' },
    { status: 410 }
  );
}
