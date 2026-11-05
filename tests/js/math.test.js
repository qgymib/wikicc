import test from "node:test";
import assert from "node:assert/strict";

import * as MathPolicy from "../../src/web/js/math.js";

test("selects the markup the build emits for math", () => {
  assert.equal(MathPolicy.BLOCK_CLASS, "math");
  assert.equal(MathPolicy.INLINE_CLASS, "math-inline");
  assert.equal(MathPolicy.SELECTOR_BLOCK, "pre.math");
  assert.equal(MathPolicy.SELECTOR_INLINE, "code.math-inline");
});

test("only runs the engine when math exists", () => {
  assert.equal(MathPolicy.shouldRenderMath(0), false);
  assert.equal(MathPolicy.shouldRenderMath(-1), false);
  assert.equal(MathPolicy.shouldRenderMath(NaN), false);
  assert.equal(MathPolicy.shouldRenderMath(Infinity), false);
  assert.equal(MathPolicy.shouldRenderMath(undefined), false);

  assert.equal(MathPolicy.shouldRenderMath(1), true);
  assert.equal(MathPolicy.shouldRenderMath(7), true);
});

test("keeps a parse failure on the page instead of throwing", () => {
  const block = MathPolicy.katexOptions(true);
  const inline = MathPolicy.katexOptions(false);

  assert.equal(block.throwOnError, false);
  assert.equal(inline.throwOnError, false);
  assert.equal(block.displayMode, true);
  assert.equal(inline.displayMode, false);
});

test("treats anything but an explicit true as inline math", () => {
  assert.equal(MathPolicy.katexOptions(undefined).displayMode, false);
  assert.equal(MathPolicy.katexOptions(null).displayMode, false);
  assert.equal(MathPolicy.katexOptions("block").displayMode, false);
  assert.equal(MathPolicy.katexOptions(1).displayMode, false);
});

test("hands the engine a fresh options object on every call", () => {
  const first = MathPolicy.katexOptions(true);
  const second = MathPolicy.katexOptions(true);

  assert.notEqual(
    first,
    second,
    "the engine may mutate the object it receives",
  );
  assert.deepEqual(first, second);
});

test("keeps the author's source on the element itself", () => {
  assert.equal(MathPolicy.SOURCE_ATTRIBUTE, "data-source");
});
