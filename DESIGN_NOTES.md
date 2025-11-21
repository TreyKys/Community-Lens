# Community Lens: Design & Implementation Notes

## 1. End-to-End Verification Design

The verification process follows a pipeline: **Search → Evidence → Source Ranking → Verdict**.

1.  **Search/Collection**:
    *   We use the **Bing Web Search API** (or SerpAPI) to retrieve top 6 results for the claim.
    *   We extract Title, URL, Snippet, and Date.
    *   *Fallback:* If no API key is present, we use a deterministic simulation based on the SHA256 hash of the claim.

2.  **Evidence Extraction & Analysis (LLM)**:
    *   The claim and search snippets are sent to OpenAI (`gpt-4o-mini` or similar).
    *   The LLM is prompted to output strict JSON containing:
        *   Per-source classification (Supports/Contradicts/Neutral).
        *   Per-source scores (Authority, Relevance, Recency, Evidence Strength).
        *   A short justification note.

3.  **Scoring & Verdict**:
    *   The system computes a weighted aggregate score (Truth Score) from the sources.
    *   The result is a 0-100 Truth Score, where < 40 is "False", 40-70 is "Uncertain", and > 70 is "True".

4.  **Provenance (DKG)**:
    *   The final verification result (ClaimReview) is published to the Decentralized Knowledge Graph (DKG).
    *   The DKG Asset ID serves as a permanent, verifiable record of the fact-check.

## 2. Scoring Formula

The backend implements the following scoring arithmetic (visible in `server/services/aiService.js`):

**Per-Source Score:**
$$ SourceScore = 0.5 \times Authority + 0.35 \times Relevance + 0.15 \times Recency $$

**Source Weight:**
$$ Weight = SourceScore \times EvidenceStrength $$

**Aggregate Score:**
$$ Aggregate = \frac{\sum (Vote \times Weight)}{\sum Weight} $$
*Where `Vote` is +1 (Supports), -1 (Contradicts), or 0 (Neutral).*

**Truth Score (0-100):**
$$ TruthScore = \left( \frac{Aggregate + 1}{2} \right) \times 100 $$

### Example Calculation

**Source 1 (Contradicts):**
*   Authority (A)=0.9, Relevance (R)=0.9, Recency (T)=0.9, Strength (S)=1.0
*   `SourceScore` = $0.5(0.9) + 0.35(0.9) + 0.15(0.9) = 0.9$
*   `Weight` = $0.9 \times 1.0 = 0.9$
*   `Vote` = -1

**Source 2 (Supports):**
*   Authority (A)=0.6, Relevance (R)=0.7, Recency (T)=0.5, Strength (S)=0.6
*   `SourceScore` = $0.5(0.6) + 0.35(0.7) + 0.15(0.5) = 0.62$
*   `Weight` = $0.62 \times 0.6 = 0.372$
*   `Vote` = +1

**Aggregation:**
*   Numerator = $(-1 \times 0.9) + (1 \times 0.372) = -0.528$
*   Denominator = $0.9 + 0.372 = 1.272$
*   Aggregate = $-0.528 / 1.272 = -0.415$
*   TruthScore = $((-0.415 + 1) / 2) \times 100 = 29.25\%$
*   **Verdict:** FALSE (since < 40%)

## 3. Frontend UX Notes

To ensure transparency and pass the "Poison Pill" demo:

1.  **Top Area**: Display the Claim, Truth Score (big number), and a Status Icon (Red Shield for False, Green Check for True).
2.  **Evidence List**:
    *   List each source with Title, URL (clickable), and Snippet.
    *   Show "Source Score" and "Vote" (Supports/Contradicts) clearly.
    *   **Math Panel**: A collapsible "Show Math" section that displays the Numerator, Denominator, and Aggregate calculation.
3.  **Publish Button**:
    *   Label: "Mint Truth Patch".
    *   Action: Calls `/api/publish` (or uses client-side publishing).
    *   Feedback: Show the resulting **Asset ID** (did:dkg:...) and a success message.
    *   *Note:* If running in simulation mode, clearly label "SIMULATED PUBLISH".
4.  **Guard Demo**:
    *   The Agent Guard (CLI or Chat UI) must query the DKG for the claim.
    *   If a Truth Patch exists and Score < 40, the Guard returns a **BLOCKED** message citing the Asset ID.

## 4. Diagnosis Checklist

To confirm the system is working:

1.  **Check Processes**: `lsof -i :4000` (Server should be running).
2.  **Check Env**: Ensure `OPENAI_API_KEY` and `BING_API_KEY` are set in `.env`.
3.  **Analyze Log**:
    *   Run `curl -X POST http://localhost:4000/api/analyze -d '{"claim":"..."}'`
    *   Check `server.log`.
    *   If log says "Fallback: search API missing...", keys are missing or invalid.
    *   If log shows "Calling OpenAI...", integration is active.
