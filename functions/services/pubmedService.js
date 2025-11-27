const { callGeminiRaw } = require('./geminiService');

async function fetchConsensusViaGemini(topic) {
  const system = `You are a Medical Research System summarizing clinical consensus. Use dry technical language, cite plausible study-type references (meta-analysis, randomized clinical trial) and approximate percentages if known. If you cannot be sure, say so. Output JSON: { "summary": "...", "confidence": 0-100, "references":[{"title":"...","url":"..."}] }`;
  const user = `Provide a concise JSON summary of the clinical consensus for: "${topic}". Include likely references and confidence (0-100).`;
  const prompt = `${system}\n\n${user}`;
  const r = await callGeminiRaw(prompt);
  // try to extract JSON blob
  try {
    // Sometimes models wrap JSON in markdown blocks
    let text = r.text;
    if (text.includes('```json')) {
        text = text.split('```json')[1].split('```')[0];
    } else if (text.includes('```')) {
        text = text.split('```')[1].split('```')[0];
    }

    const json = JSON.parse(text);
    return json;
  } catch (e) {
    console.warn("Failed to parse Gemini JSON, falling back to text wrap", e);
    // fallback: wrap text in summary field with low confidence
    return { summary: r.text.slice(0,1000), confidence: 40, references: [] };
  }
}

module.exports = { fetchConsensusViaGemini };
