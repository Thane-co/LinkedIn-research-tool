// Layer 0 — cheap non-English heuristic (PRD §10.3). Zero I/O.
// Heuristic: of the alphabetic characters, if more than 30% are non-Latin script, treat as
// non-English. Accented Latin (café) stays English; CJK/Cyrillic/Arabic get flagged.

const NON_ENGLISH_LETTER_RATIO = 0.3

/** True when the text looks predominantly non-English. Null/empty/letterless -> false. */
export function isLikelyNonEnglish(text: string | null | undefined): boolean {
  if (!text) return false

  const letters = text.match(/\p{L}/gu)
  if (!letters || letters.length === 0) return false

  const latin = text.match(/\p{Script=Latin}/gu)
  const latinCount = latin ? latin.length : 0
  const nonLatinRatio = (letters.length - latinCount) / letters.length

  return nonLatinRatio > NON_ENGLISH_LETTER_RATIO
}
