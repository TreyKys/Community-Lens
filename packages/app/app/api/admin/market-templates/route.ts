import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET    /api/admin/market-templates          — list, newest first
// POST   /api/admin/market-templates          — save a new template
// DELETE /api/admin/market-templates?id=123   — remove one
//
// A template is a saved, named market "shape" for one-click reuse from
// the Create tab — see applyClone/applyTemplate in admin/page.tsx. It
// stores the exact same fields a market row does (including locked-odds
// config) so quick-create can prefill the form through the same code
// path Clone & Edit already uses, then submit through the normal
// /api/admin/market endpoint like any other market.

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { data, error } = await supabaseAdmin
    .from('market_templates')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ templates: data || [] });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json();
    const {
      name, question, category, options,
      sport, homeTeam, awayTeam, leagueCode, description,
      defaultClosesInHours,
      // Locked-odds config — defaults to on, matching every other
      // creation surface now that locked odds is the norm rather than
      // an opt-in per market.
      isLockedOdds,
      seedPool,          // pre-computed {index: tngn} map, see client
      seedProbability,
      vigPct,
    } = body;

    if (!name || !category || !Array.isArray(options) || options.length < 2) {
      return NextResponse.json({ error: 'Missing required fields: name, category, options (2+)' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('market_templates')
      .insert({
        name: String(name).slice(0, 100),
        question: question || '',
        category,
        options,
        sport: sport || null,
        home_team: homeTeam || null,
        away_team: awayTeam || null,
        league_code: leagueCode || null,
        description: description || null,
        default_closes_in_hours: defaultClosesInHours || null,
        is_locked_odds: isLockedOdds !== false,
        seed_pool: seedPool || {},
        seed_probability: seedProbability ?? null,
        vig_pct: vigPct ?? null,
        created_by: 'admin',
      })
      .select('*')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, template: data }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const id = Number(searchParams.get('id'));
  if (!id) return NextResponse.json({ error: 'Provide ?id=' }, { status: 400 });

  const { error } = await supabaseAdmin.from('market_templates').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
