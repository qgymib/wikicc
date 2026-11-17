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

/** The payload format version this reader speaks. */
export var PAYLOAD_VERSION = 1;

/**
 * The problem with `value` as the payload format version of `what`, or
 * `null` when this reader speaks it.
 *
 * `what` names the surface the value came from — "The site payload", "The
 * document chunk", "The search corpus" — so the refusal says which file it
 * turned away. A missing field and anything other than the version above
 * are refused alike: both mean the artifact was not built by a compatible
 * wikicc, and neither is something rendering could survive.
 */
export function versionProblem(value, what) {
  var subject = typeof what === "string" && what ? what : "The payload";
  if (value === undefined || value === null) {
    return (
      subject +
      " carries no payload format version; rebuild the site with wikicc to read it."
    );
  }
  if (value !== PAYLOAD_VERSION) {
    return (
      subject +
      " was built for payload format version " +
      value +
      ", and this reader speaks version " +
      PAYLOAD_VERSION +
      "; rebuild the site with a matching version of wikicc to read it."
    );
  }
  return null;
}
