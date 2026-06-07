import { NextResponse } from 'next/server';

// Paystack webhook deprecated. We ack with 200 to stop Paystack from retrying
// indefinitely if our account still has a webhook registered upstream.
export async function POST() {
  return NextResponse.json({ ok: true, note: 'paystack integration removed' });
}
