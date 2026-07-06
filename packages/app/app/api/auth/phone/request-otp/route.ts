import { NextResponse } from 'next/server';
import { normalizeNigerianPhone, sendOtp } from '@/lib/termii';

/**
 * POST /api/auth/phone/request-otp
 *
 * Sends a 6-digit SMS code via Termii to a Nigerian phone number.
 * Returns the Termii pinId — the client resubmits it (along with the code
 * the user types in) to /api/auth/phone/verify-otp.
 */
export async function POST(request: Request) {
  try {
    const { phone } = await request.json();
    if (!phone) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 });
    }

    const normalized = normalizeNigerianPhone(String(phone));
    if (!normalized) {
      return NextResponse.json({ error: 'Enter a valid Nigerian phone number' }, { status: 400 });
    }

    const { pinId } = await sendOtp(normalized);

    return NextResponse.json({ pinId, phone: normalized });
  } catch (error: any) {
    console.error('Phone OTP request error:', error);
    return NextResponse.json({ error: error.message || 'Could not send verification code' }, { status: 500 });
  }
}
