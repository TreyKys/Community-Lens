import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy-for-build.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date().toISOString();

    // Check if batch creation
    if (body.isBatch) {
      const { questions, optionsArr, durations, parentIds } = body;

      if (!questions || !optionsArr || !durations) {
          return NextResponse.json({ error: 'Missing batch parameters' }, { status: 400 });
      }

      const inserts = questions.map((q: string, i: number) => {
          const closesAt = new Date(Date.now() + durations[i] * 1000).toISOString();
          return {
              id: crypto.randomBytes(16).toString('hex'), // Generate unique alphanumeric ID
              question: q,
              options: optionsArr[i],
              closes_at: closesAt,
              status: 'open',
              parent_market_id: parentIds && parentIds[i] !== 0 ? parentIds[i] : null,
              created_at: now
          };
      });

      const { error } = await supabase.from('markets').insert(inserts);
      if (error) throw error;

      return NextResponse.json({ success: true, count: inserts.length }, { status: 200 });

    } else {
      // Single creation
      const { question, options, duration, parentMarketId } = body;

      if (!question || !options || !duration) {
          return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
      }

      const closesAt = new Date(Date.now() + duration * 1000).toISOString();
      const marketId = crypto.randomBytes(16).toString('hex');

      const { data, error } = await supabase.from('markets').insert({
          id: marketId,
          question,
          options,
          closes_at: closesAt,
          status: 'open',
          parent_market_id: parentMarketId && parentMarketId !== '0' ? parentMarketId : null,
          created_at: now
      }).select().single();

      if (error) throw error;

      return NextResponse.json({ success: true, market: data }, { status: 200 });
    }
  } catch (error: unknown) {
    console.error('Market creation error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
