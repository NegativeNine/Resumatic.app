import { PlaceholderSection } from "../Placeholder";
import { SensitiveButton, SensitiveWell, type SensitiveControl } from "../SensitiveControl";
import { Glyph } from "../ui";

/**
 * The choices under a fact on To check that most people never need: keep it private, and, not
 * built yet, split it in two. The row says what keeping it private does before it is chosen, and
 * only what the privacy notice promises.
 */
export function MoreChoices({
  control,
  marked,
  describedBy,
  disabled,
}: {
  control: SensitiveControl;
  marked: boolean;
  /** ID of the fact's text, so screen readers announce it with the button. */
  describedBy: string;
  disabled: boolean;
}) {
  return (
    <details className="rs-more facts-more">
      <summary>
        <Glyph name="chevron" />
        More choices <span className="rs-more__hint">Keep it private, or split it in two</span>
      </summary>
      <div className="rs-more__body facts-more__body">
        <div className="app-row app-row--top facts-more__row">
          <p className="rs-p facts-more__text">
            <strong>Keep private:</strong> never used in a new resume, letter, interview preparation or fit preview,
            never put in a shared copy and never shown to a connected app. A resume that already uses it can’t be
            downloaded or shared until those lines go.
          </p>
          <SensitiveButton control={control} marked={marked} describedBy={describedBy} disabled={disabled} />
        </div>
        <SensitiveWell control={control} disabled={disabled} />
        <PlaceholderSection name="factsSplit" />
      </div>
    </details>
  );
}
