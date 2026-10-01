/**
 * Plugin-level tests: registration, config plumbing and the report contract.
 *
 * The engine is injected here, so these tests say nothing about OCR quality —
 * `vision.test.mjs` covers that against a real image. What they do pin down is
 * everything between the host and the engine: that both tools register, that a
 * live volatile config reach es the engine arguments, and that a failing engine
 * becomes a visible tool error instead of an empty reading.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, renderReport } from "../index.mjs";

/** A cordis-shaped context that records what the plugin registers. */
function fakeContext() {
  const tools = [];
  return {
    tools,
    logger: { info() {}, warn() {} },
    ctx: { tools: { register: (definition) => { tools.push(definition); return () => {}; } } },
  };
}

/** A result shaped like the engine's. */
function resultFixture(overrides = {}) {
  return {
    engine: "vision",
    recognizer: "accurate",
    requestedLanguages: [],
    effectiveLanguages: [],
    lines: [
      { text: "Договор управления", confidence: 0.99, box: null },
      { text: "Общото сьбрание", confidence: 0.5, box: null },
    ],
    text: "Договор управления\nОбщото сьбрание",
    ...overrides,
  };
}

/** Mount the plugin with injected engines and return the registered tools. */
async function mount({ recognize, engineStatus, config } = {}) {
  const { ctx, tools } = fakeContext();
  await apply(ctx, config ?? {}, {
    recognize: recognize ?? (async () => resultFixture()),
    engineStatus: engineStatus ?? (async () => ({
      platform: "darwin",
      vision: { available: true, languages: ["en-US"] },
      tesseract: { available: false, error: "tesseract is not installed" },
      selected: "vision",
    })),
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

test("apply registers both tools, and no host row", async () => {
  const tools = await mount();
  assert.deepEqual(Object.keys(tools).sort(), ["ocr_image", "ocr_status"]);
  assert.equal(tools.ocr_image.parameters.type, "object");
  assert.deepEqual(tools.ocr_image.parameters.properties.path.type, "string");
  assert.deepEqual(tools.ocr_image.parameters.required, ["path"]);
});

test("the rendered output carries the engine, the text and the uncertain lines", async () => {
  const tools = await mount();
  const text = await tools.ocr_image.execute({ path: "/tmp/x.png" }, {});
  assert.match(text, /\[dsh-ocr-vision\] engine=vision recognizer=accurate lines=2/);
  assert.match(text, /=== text ===\nДоговор управления\nОбщото сьбрание/);
  assert.match(text, /=== uncertain \(confidence < 0\.7\) ===\n\[0\.50\] Общото сьбрание/);
});

test("volatile accessors are unwrapped per call, so a settings edit lands", async () => {
  let seen = null;
  const current = { engine: "tesseract", langs: ["bul", "rus"], fast: true };
  const tools = await mount({
    recognize: async (_path, options) => { seen = options; return resultFixture(); },
    // Every field arrives as a live accessor on DSH 0.1.7+.
    config: Object.fromEntries(
      Object.entries({ ...current, timeoutMs: 4000, maxChars: 100, lowConfidence: 0.7 })
        .map(([key, value]) => [key, { get: () => value }]),
    ),
  });
  await tools.ocr_image.execute({ path: "/tmp/x.png" }, {});
  assert.equal(seen.engine, "tesseract");
  assert.deepEqual(seen.langs, ["bul", "rus"]);
  assert.equal(seen.fast, true);
  assert.equal(current.engine, "tesseract");
});

test("per-call arguments override the configuration", async () => {
  let seen = null;
  const tools = await mount({ recognize: async (_path, options) => { seen = options; return resultFixture(); } });
  await tools.ocr_image.execute({ path: "/tmp/x.png", engine: "tesseract", fast: true, langs: ["bul"] }, {});
  assert.equal(seen.engine, "tesseract");
  assert.equal(seen.fast, true);
  assert.deepEqual(seen.langs, ["bul"]);
});

test("a failing engine is a visible tool error, not an empty reading", async () => {
  const tools = await mount({
    recognize: async () => { throw new Error("no usable OCR engine. Apple Vision: no toolchain"); },
  });
  await assert.rejects(() => tools.ocr_image.execute({ path: "/tmp/x.png" }, {}), /no usable OCR engine/);
});

test("ocr_status reports both engines and the active choice", async () => {
  const tools = await mount();
  const text = await tools.ocr_status.execute({}, {});
  assert.match(text, /platform=darwin selected=vision/);
  assert.match(text, /vision: available=true languages=1/);
  assert.match(text, /tesseract: available=false error=tesseract is not installed/);
  assert.match(text, /config: engine=auto fast=false langs=\(engine default\)/);
});

test("renderReport keeps an empty result explicit", () => {
  const text = renderReport({ engine: "vision", lines: [], text: "", elapsedMs: 1200 });
  assert.match(text, /lines=0/);
  assert.match(text, /\(no text recognised in this image\)/);
  assert.doesNotMatch(text, /uncertain/);
});

test("renderReport truncates loudly, never silently", () => {
  const long = "я".repeat(100);
  const text = renderReport({ engine: "vision", lines: [], text: long, elapsedMs: 10 }, { maxChars: 40 });
  assert.match(text, /\[truncated: 60 more characters — raise maxChars to see them\]/);
});

test("renderReport repeats an engine warning and the language substitution", () => {
  const text = renderReport({
    engine: "vision",
    effectiveLanguages: [],
    requestedLanguages: ["ru-RU"],
    warning: "fast recogniser is Latin-only on this platform",
    lines: [],
    text: "x",
    elapsedMs: 10,
  });
  assert.match(text, /warning: fast recogniser is Latin-only/);
  assert.match(text, /the engine accepted none of the requested languages \(ru-RU\)/);
});
