import { EXPERIENCE_BANDS, MAX_CARD_SKILLS, MAX_CARD_TEXT_CHARS, type CardPreview } from "../shared/card";
import { api, ApiError } from "./api";

// What the card preview takes from the server: one of the two shapes the contract names, exactly,
// and nothing else. Anything more or less is shown as an incomplete reply, never as a card.

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((key, index) => own[index] === key);
};
const isText = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= MAX_CARD_TEXT_CHARS;
const isConcept = (value: unknown) => isRecord(value) && hasKeys(value, ["id", "label"]) && isText(value.id) && isText(value.label);

/** A reply that is exactly a card preview: unavailable, or a ready card of the contract's shape. */
export function isCardPreview(value: unknown): value is CardPreview {
  if (!isRecord(value)) return false;
  if (value.state === "unavailable") return hasKeys(value, ["state"]);
  if (value.state !== "ready" || !hasKeys(value, ["state", "taxonomyVersion", "card"]) || !isText(value.taxonomyVersion)) return false;
  const card = value.card;
  if (!isRecord(card) || !hasKeys(card, ["occupation", "experience", "skills"])) return false;
  if (card.occupation !== null && !isConcept(card.occupation)) return false;
  if (card.experience !== null && card.experience !== "unknown" && !(EXPERIENCE_BANDS as readonly unknown[]).includes(card.experience)) return false;
  return Array.isArray(card.skills) && card.skills.length <= MAX_CARD_SKILLS && card.skills.every(isConcept);
}

/** Reads the owner's card preview, and takes nothing but a whole one. */
export async function loadCardPreview(): Promise<CardPreview> {
  const loaded = await api.cardPreview();
  if (!isCardPreview(loaded)) throw new ApiError(502, "unavailable", "The response was incomplete.");
  return loaded;
}
