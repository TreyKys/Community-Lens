import { NextResponse } from 'next/server';

// Proxies RPC requests to Pimlico to bypass geo-blocking or inject API keys safely
export async function POST(req: Request) {
  try {
    const rawBody = await req.json();

    const pimlicoUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL;

    if (!pimlicoUrl) {
      console.error("Missing NEXT_PUBLIC_PAYMASTER_URL");
      return NextResponse.json({ error: "Paymaster not configured" }, { status: 500 });
    }

    const response = await fetch(pimlicoUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rawBody),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });

  } catch (error: unknown) {
    console.error('Paymaster proxy error:', error);
    return NextResponse.json({ error: 'Internal Server Error', message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
