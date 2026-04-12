import { NextResponse } from 'next/server';

// POST /api/admin/generate-markets
// Accepts a document (text content) and uses Claude to generate
// structured prediction market objects for TreyKy to review before submission.

const SYSTEM_PROMPT = `You are a prediction market curator for TruthMarket, Nigeria's leading prediction platform.

Your job is to read a document and generate high-quality prediction markets from it.

Rules:
- Questions must be specific, answerable, and verifiable
- Each question must resolve before or on the closes_at date
- Options must be mutually exclusive and exhaustive
- For sports: always include all realistic outcomes (don't omit Draw for football)
- For yes/no markets: phrase the question so "Yes" is the interesting outcome
- For Nigerian politics/culture: use local context, real names, real institutions
- Closes_at should be set to just before the event resolves (kickoff for sports, announcement date for politics)
- Generate between 5 and 20 markets depending on document richness

Output ONLY a valid JSON array. No explanation. No markdown. No backticks. Raw JSON only.

Each market object must have exactly these fields:
{
  "question": "string — clear prediction question",
  "category": "sports | politics | economics | entertainment | finance",
  "sport": "football | basketball | tennis | esports | null",
  "options": ["string", "string"],
  "closes_at": "ISO 8601 datetime string",
  "fixture_id": null,
  "home_team": "string or null",
  "away_team": "string or null",
  "notes": "string — brief explanation of why this is a good market"
}`;

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
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
${documentContent}

Generate prediction markets from this document. Focus on:
- Upcoming events mentioned that have clear outcomes
- Nigerian market relevance (CBN, NNPC, INEC, local sports teams, entertainment)
- Events that resolve within 1-90 days
- Markets that Nigerian users would find engaging and bet on

Remember: output ONLY the JSON array.`;

    // Call Gemini API
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      console.error('Missing GEMINI_API_KEY');
      return NextResponse.json({ error: 'AI API key not configured' }, { status: 500 });
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [{
          parts: [{ text: userPrompt }]
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4000,
          responseMimeType: "application/json"
        }
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini API error:', err);
      return NextResponse.json({ error: 'AI generation failed. Try again.' }, { status: 500 });
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse the JSON array from the response
    let markets: any[] = [];
    try {
      // Strip any accidental markdown fences
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      markets = JSON.parse(cleaned);

      if (!Array.isArray(markets)) {
        throw new Error('Response is not an array');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', rawText.slice(0, 500));
      return NextResponse.json({
        error: 'AI returned malformed data. Please try again with a clearer document.',
      }, { status: 500 });
    }

    // Validate and sanitize each market
    const validatedMarkets = markets
      .filter(m => m.question && m.category && Array.isArray(m.options) && m.options.length >= 2 && m.closes_at)
      .map((m, i) => ({
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
        notes: m.notes || '',
        approved: false, // All start as not approved
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
