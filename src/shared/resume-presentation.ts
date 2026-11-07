/** Remove an imported list marker from a line already presented as a bullet.
 * Keep saved versions and their evidence unchanged. Only unwrap lines with a
 * marker: other lines may contain deliberate breaks in a user's edits.
 */
export function presentResumeBullet(text: string): string {
  const marker = /^\s*(?:(?:[-*+•▪●‣◦]|\d+[.)])\s+)+/u;
  if (!marker.test(text)) return text;
  return text.replace(marker, "").replace(/\s*\r?\n\s*/gu, " ").trim();
}
