export const ESCO_URI_PREFIX: string;
/** True for a well-formed concept ID. It says nothing about whether the concept exists. */
export function validConceptId(value: unknown): value is string;
/** The ID of an ESCO concept from its URI, or null when the URI isn't one of ESCO's. */
export function escoId(uri: unknown): string | null;
/** The URI ESCO publishes a concept under, from its ID. Null for an ID that isn't ESCO's. */
export function escoUri(id: unknown): string | null;
/** True for an O*NET-SOC code as the database writes it: 15-1252.00. */
export function validOnetSoc(code: unknown): code is string;
export function onetOccupationId(code: unknown): string | null;
/** An element of O*NET's content model, such as a work activity or a software category. */
export function onetElementId(kind: "activity" | "toolcat", element: unknown): string | null;
export function onetTaskId(task: unknown): string | null;
/** The ID of a software example, made from its name in comparison form. */
export function onetToolId(norm: unknown): string | null;
/** The source a concept comes from. Null for a malformed ID. */
export function schemeOf(id: unknown): "esco" | "onet" | null;
