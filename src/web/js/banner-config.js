/**
 * Timing of the missing-chapter banner.
 *
 * A separate module because two callers disagree about when the value is
 * needed: `banner.js` uses it at runtime, and a test can import it without
 * pulling in the DOM-building module at all.
 */

/**
 * How long the banner stays on screen unless it is dismissed first.
 *
 * Long enough to read a document path plus a heading, short enough that a
 * reader who has understood it is not left with a message about a navigation
 * that is already over.
 */
export var BANNER_TIMEOUT_MS = 6000;
