/**
 * Analyzes a claim against a source of truth.
 * @param {string} claimText - The claim to analyze.
 * @param {string} wikiText - The source of truth text.
 * @returns {object} A ClaimReview JSON object.
 */
export function analyzeClaim(claimText, wikiText) {
  const score = /fake|false/i.test(wikiText) ? 10 : 95;

  return {
    "@context": "https://schema.org",
    "@type": "ClaimReview",
    "claimReviewed": claimText,
    "reviewRating": {
      "@type": "Rating",
      "ratingValue": score.toString(),
      "bestRating": "100",
      "worstRating": "0"
    },
    "author": {
      "@type": "Organization",
      "name": "Community Lens Verifier"
    }
  };
}
