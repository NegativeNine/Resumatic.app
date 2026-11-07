/**
 * Presents a message as the interface writes one: a capital first letter, each "; " read as a new
 * sentence, and a full stop at the end. A message already written as sentences comes back unchanged.
 * Older stored messages and the long tail of server details ("the resume changed; refresh and try
 * again") read as sentences on screen this way.
 */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const joined = trimmed.split(/;\s+/).map(capitalise).join(". ");
  return /[.!?…]$/.test(joined) ? joined : `${joined}.`;
}

function capitalise(part: string): string {
  return part ? part[0]!.toUpperCase() + part.slice(1) : part;
}
