import test from "node:test";
import assert from "node:assert/strict";

import * as Diagrams from "../../src/web/js/diagrams.js";

test("selects the markup the build emits for a mermaid fence", () => {
  assert.equal(Diagrams.CLASS, "mermaid");
  assert.equal(Diagrams.SELECTOR, "pre.mermaid");
});

test("only initialises the engine when a diagram exists", () => {
  assert.equal(Diagrams.shouldInitMermaid(0), false);
  assert.equal(Diagrams.shouldInitMermaid(-1), false);
  assert.equal(Diagrams.shouldInitMermaid(NaN), false);
  assert.equal(Diagrams.shouldInitMermaid(Infinity), false);
  assert.equal(Diagrams.shouldInitMermaid(undefined), false);

  assert.equal(Diagrams.shouldInitMermaid(1), true);
  assert.equal(Diagrams.shouldInitMermaid(7), true);
});

test("maps the reader theme to a diagram theme", () => {
  assert.equal(Diagrams.mermaidTheme("light"), "default");
  assert.equal(Diagrams.mermaidTheme("dark"), "dark");
  assert.equal(Diagrams.mermaidTheme(undefined), "dark");
  assert.equal(Diagrams.mermaidTheme("solarized"), "dark");
});

test("disables auto-start and sanitises labels", () => {
  const config = Diagrams.mermaidConfig("dark");

  assert.equal(config.startOnLoad, false);
  assert.equal(config.theme, "dark");
  assert.equal(config.securityLevel, "strict");
  assert.equal(Diagrams.mermaidConfig("light").theme, "default");
});

test("hands the engine a fresh config object on every call", () => {
  const first = Diagrams.mermaidConfig("dark");
  const second = Diagrams.mermaidConfig("dark");

  assert.notEqual(first, second, "the engine may mutate the object it receives");
  assert.deepEqual(first, second);
});

test("detects a document that carries diagram source", () => {
  assert.equal(
    Diagrams.hasDiagramSource('<p>text</p><pre class="mermaid">graph TD; A--&gt;B;</pre>'),
    true,
  );
  assert.equal(Diagrams.hasDiagramSource("<p>no diagrams here</p>"), false);
  assert.equal(Diagrams.hasDiagramSource('<pre class="code">graph TD;</pre>'), false);
  assert.equal(Diagrams.hasDiagramSource(""), false);
  assert.equal(Diagrams.hasDiagramSource(null), false);
  assert.equal(Diagrams.hasDiagramSource(undefined), false);
});
