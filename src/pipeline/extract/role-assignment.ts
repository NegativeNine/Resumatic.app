import type { Span } from "../../grounding/offsets";

interface RoleSection {
  key: string;
  span: Span;
}

/**
 * Keep a proposed role only when it is the unique nearest preceding extracted
 * header and no other Markdown heading intervenes. This is a conservative
 * layout check, not proof that conversion preserved the document's reading
 * order or that every role header was extracted.
 */
export function supportedRoleAssignment(
  markdown: string,
  factSpan: Span,
  proposedRole: string | null,
  roles: readonly RoleSection[],
): string | null {
  if (!proposedRole) return null;
  const role = roles.find((item) => item.key === proposedRole);
  if (!role || role.span[1] > factSpan[0]) return null;

  // Co-located or overlapping role headers do not have a reliable order.
  if (
    roles.some(
      (other) =>
        other !== role &&
        other.span[0] < role.span[1] &&
        role.span[0] < other.span[1],
    )
  ) return null;
  if (
    roles.some(
      (other) =>
        other !== role &&
        other.span[0] >= role.span[1] &&
        other.span[0] < factSpan[1],
    )
  ) return null;

  const between = markdown.slice(role.span[1], factSpan[0]);
  if (/^\s{0,3}#{1,6}\s+\S/m.test(between)) return null;
  return proposedRole;
}
