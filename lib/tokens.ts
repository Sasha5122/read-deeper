/**
 * Cheap token estimate for budgeting (~4 chars/token for English prose).
 * Used only to trim context client-side of the API; billing truth comes from
 * the API's usage block.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
