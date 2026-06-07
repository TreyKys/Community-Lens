import { NextResponse } from 'next/server';

// Paystack integration was scrapped per board decision.
// We keep a stub so the old verify callback URL still resolves cleanly,
// rather than throwing an unhandled error.
export async function GET() {
  return NextResponse.json(
    { error: 'Paystack is no longer supported. Existing pending transactions have been refunded — contact support if you need help.' },
    { status: 410 }
  );
}

export async function POST() {
  return GET();
}
