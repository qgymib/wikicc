/**
 * The payload format version and the one check every entry point runs.
 *
 * Every JSON surface the build hands the reader — the embedded bundle, the
 * pages manifest, the per-document chunks and the search corpus — leads
 * with a version number (`"v":1` in the current format). This module is the
 * one place that knows which version this reader speaks and how to refuse
 * one it does not: a surface whose version is missing or unknown is
 * answered with a sentence that names the problem and the fix, so an
 * artifact from an incompatible build fails clearly instead of breaking
 * downstream (see `docs/design.md`, contracts).
 *
 * Pure: no DOM. `node --test` drives it directly.
 */
import { t } from "./i18n.js";

/** The payload format version this reader speaks. */
export var PAYLOAD_VERSION = 1;

/**
 * The problem with `value` as the payload format version of `what`, or
 * `null` when this reader speaks it.
 *
 * `what` names the surface the value came from — the site payload, the
 * document chunk, the search corpus — so the refusal says which file it
 * turned away; the callers pass the subject in the language in effect, and
 * an unnamed surface falls back to the plain one. A missing field and
 * anything other than the version above are refused alike: both mean the
 * artifact was not built by a compatible wikicc, and neither is something
 * rendering could survive.
 */
export function versionProblem(value, what) {
  var subject =
    typeof what === "string" && what ? what : t("payload.subject.fallback");
  if (value === undefined || value === null) {
    return t("payload.noVersion", { subject: subject });
  }
  if (value !== PAYLOAD_VERSION) {
    return t("payload.versionMismatch", {
      subject: subject,
      found: String(value),
      expected: String(PAYLOAD_VERSION),
    });
  }
  return null;
}
