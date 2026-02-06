/**
 * Generate a URL-friendly slug from text.
 * Takes the first few words, lowercases, strips non-alphanumeric, joins with hyphens.
 * Appends a short random suffix to avoid collisions.
 */
export function slugify(text: string, maxWords = 6): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join("-");

  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}
