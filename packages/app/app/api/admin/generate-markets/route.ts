import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/adminAuth';

// POST /api/admin/generate-markets
// Accepts a document (text content) and uses Gemini to generate
// structured prediction market objects for review before submission.

const SYSTEM_PROMPT = `You are a prediction market curator for Odds.ng, Nigeria's leading event-derivative market.

Your job: read a document and extract or generate high-quality prediction markets.

The document may be in any of these formats — handle them all:
- Numbered lists ("1. The Arsenal Bottle Job (Narrative Market)")
- Section headers with emojis ("🎵 Pop Culture & Afrobeats")
- A market line followed by a "Why it works:" rationale and an "Oracle:" data source
- Plain prose with embedded events
- Fixture lists or schedules

When the document already lists candidate markets (with "The Market:", "Why it works:", "Oracle:" structure), preserve the author's intent — copy the question and rationale faithfully. When the document is raw source material (news, fixtures), generate fresh markets from it.

Rules:
- Questions must be specific, answerable, and verifiable from a clearly named source
- Each question must resolve before or on the closes_at date
- Options must be mutually exclusive and exhaustive
- For sports: include all realistic outcomes (don't omit Draw for football)
- For yes/no markets: phrase the question so "Yes" is the interesting/contrarian outcome
- For Nigerian politics/culture/economy: use local context, real names, real institutions, NGN currency
- closes_at: set to just before the event resolves (kickoff for sports, deadline for "before X date" markets)
- description: 1-3 sentences explaining WHY users will care or bet on this. Capture the cultural hook, rivalry, or stakes. Copy "Why it works:" rationale verbatim if the document has one.
- Generate as many markets as the document warrants (typically 5-20). Do not pad with low-quality markets.

Output ONLY a valid JSON array. No prose. No markdown. No code fences. Just \`[...]\`.

Each market object must have exactly these fields:
{
  "question": "string — clear prediction question, max 200 chars",
  "category": "sports | politics | economics | entertainment | finance",
  "sport": "football | basketball | tennis | esports | null",
  "options": ["Yes", "No"]  or  ["Home Win", "Draw", "Away Win"]  or  custom array of 2-4 strings,
  "closes_at": "ISO 8601 datetime string with timezone (e.g. 2026-05-17T22:59:00Z)",
  "fixture_id": null,
  "home_team": "string or null (only for sports)",
  "away_team": "string or null (only for sports)",
  "description": "1-3 sentences. The 'why it works' / cultural hook / what makes this engaging."
}`;

// Strip code fences and any leading/trailing prose so JSON.parse has a chance.
// Handles: ```json [...] ```, leading "Here's the array:", trailing "That's it!" etc.
function extractJsonArray(text: string): string {
  if (!text) return '';
  // Drop markdown fences
  let t = text.replace(/```(?:json|JSON)?/g, '').replace(/```/g, '').trim();
  // If the response starts with prose, find the first '[' and last ']'.
  const first = t.indexOf('[');
  const last = t.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) return t;
  return t.slice(first, last + 1);
}

export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { documentContent, documentName, contextDate } = body;

    if (!documentContent) {
      return NextResponse.json({ error: 'documentContent is required' }, { status: 400 });
    }

    if (documentContent.length > 50000) {
      return NextResponse.json({ error: 'Document too long. Max 50,000 characters.' }, { status: 400 });
    }

    const today = contextDate || new Date().toISOString().split('T')[0];

    const userPrompt = `Today's date is ${today}.

Document name: ${documentName || 'Untitled'}

Document content:
---
${documentContent}
---

Generate prediction markets from this document. Focus on:
- Upcoming events with clear, verifiable outcomes
- Nigerian market relevance (CBN, NNPC, INEC, NEPA/grid, Naira/USD, NPFL, Afrobeats artists, Nollywood, local crypto adoption)
- Events that resolve within 1-90 days from today
- Markets with cultural pull — rivalries, stan wars, political beefs, viral moments

If the document already structures markets with "The Market:" / "Why it works:" / "Oracle:" — copy them faithfully. The "Why it works" line should become the "description" field.

Remember: output ONLY the JSON array. Start with [ and end with ].`;

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      console.error('Missing GEMINI_API_KEY');
      return NextResponse.json({ error: 'AI API key not configured' }, { status: 500 });
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          // 16k is enough for ~25 verbose markets with descriptions; old 4k truncated mid-JSON.
          maxOutputTokens: 16000,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini API error:', err);
      return NextResponse.json({ error: 'AI generation failed. Try again.' }, { status: 500 });
    }

    const data = await response.json();
    const finishReason = data.candidates?.[0]?.finishReason;
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse the JSON array from the response, with graceful recovery
    let markets: any[] = [];
    try {
      const cleaned = extractJsonArray(rawText);
      markets = JSON.parse(cleaned);
      if (!Array.isArray(markets)) {
        throw new Error('Response is not an array');
      }
    } catch (parseError: any) {
      console.error('Failed to parse AI response. finishReason=' + finishReason + '. First 500 chars:', rawText.slice(0, 500));
      const hint = finishReason === 'MAX_TOKENS'
        ? 'AI response was cut off mid-output. Try a shorter document or fewer markets.'
        : 'AI returned malformed JSON. The document may be too unstructured — try splitting it or rewriting as a list.';
      return NextResponse.json({
        error: hint,
        debug: { finishReason, rawTextSnippet: rawText.slice(0, 300) },
      }, { status: 500 });
    }

    // Validate and sanitize each market. Accept legacy "notes" as a fallback for description
    // (in case the model echoes the old field name).
    const validatedMarkets = markets
      .filter((m: any) => m.question && m.category && Array.isArray(m.options) && m.options.length >= 2 && m.closes_at)
      .map((m: any, i: number) => ({
        id: `draft_${Date.now()}_${i}`,
        question: String(m.question).slice(0, 200),
        category: ['sports', 'politics', 'economics', 'entertainment', 'finance'].includes(m.category)
          ? m.category : 'sports',
        sport: m.sport || null,
        options: (m.options as string[]).slice(0, 4).map((o: string) => String(o).slice(0, 80)),
        closes_at: m.closes_at,
        fixture_id: m.fixture_id || null,
        home_team: m.home_team || null,
        away_team: m.away_team || null,
        description: String(m.description || m.notes || '').slice(0, 800),
        approved: false,
      }));

    if (validatedMarkets.length === 0) {
      return NextResponse.json({
        error: 'No valid markets could be generated from this document. Try a document with upcoming events or match fixtures.',
      }, { status: 422 });
    }

    console.log(`[AI Markets] Generated ${validatedMarkets.length} markets from "${documentName || 'doc'}"`);

    return NextResponse.json({
      success: true,
      markets: validatedMarkets,
      count: validatedMarkets.length,
      documentName: documentName || 'Untitled',
    });

  } catch (error: any) {
    console.error('Generate markets error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
