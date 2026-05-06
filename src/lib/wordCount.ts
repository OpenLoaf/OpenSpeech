export const TYPING_BASELINE_WPM = 40;

export function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[一-鿿]|[A-Za-z0-9][A-Za-z0-9'_-]*/g);
  return matches ? matches.length : 0;
}
