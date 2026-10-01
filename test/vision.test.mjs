/**
 * Engine tests for dsh-ocr-free.
 *
 * The interesting assertions are the ones about failure: an OCR tool whose
 * engine is missing must say so, not return an empty string. The macOS-only
 * tests compile the real engine and read a real image, because the whole point
 * of this plugin is that no install step stands between "tool called" and "text
 * returned" — a mocked engine would prove nothing about that.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveConfig, validate, defaults } from "../config.mjs";
import { ENGINES, engineStatus, recognize } from "../src/host/engines.js";
import { parseTsv, recognizeWithTesseract } from "../src/host/tesseract.js";
import {
  OcrEngineError, ensureVisionBinary, expandPath, recognizeWithVision, renderText,
} from "../src/host/vision.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "ocr-free-test-"));
const MACOS = process.platform === "darwin";
const CYRILLIC = join(FIXTURES, "cyrillic.png");
const BLANK = join(FIXTURES, "blank.png");

/* ------------------------------------------------------------------ config */

test("shipped defaults are valid", () => {
  assert.deepEqual(resolveConfig(), defaults());
});

test("an unknown engine is rejected at composition", () => {
  assert.throws(() => resolveConfig({ engine: "magic" }), /engine must be one of/);
});

test("a confidence threshold outside [0, 1] is rejected", () => {
  assert.throws(() => resolveConfig({ lowConfidence: 1.5 }), /lowConfidence must be in \[0, 1\]/);
});

test("langs must be an array of identifiers", () => {
  assert.throws(() => resolveConfig({ langs: "ru-RU" }), /langs must be an array/);
  assert.throws(() => resolveConfig({ langs: [""] }), /langs must be an array/);
  assert.deepEqual(resolveConfig({ langs: ["ru-RU", "en-US"] }).langs, ["ru-RU", "en-US"]);
});

test("row config overrides only what it names", () => {
  const resolved = resolveConfig({ fast: true });
  assert.equal(resolved.fast, true);
  assert.equal(resolved.engine, defaults().engine);
  assert.equal(resolved.timeoutMs, defaults().timeoutMs);
});

test("validate returns the same object it was given", () => {
  const config = defaults();
  assert.equal(validate(config), config);
});

/* ------------------------------------------------------------- text render */

test("renderText keeps reading order and separates distant blocks", () => {
  const lines = [
    { text: "Шапка", box: { x: 0, y: 0, width: 0.1, height: 0.02 } },
    { text: "вторая строка", box: { x: 0, y: 0.03, width: 0.2, height: 0.02 } },
    { text: "далеко", box: { x: 0, y: 0.5, width: 0.1, height: 0.02 } },
  ];
  assert.equal(renderText(lines), "Шапка\nвторая строка\n\nдалеко");
});

test("renderText without boxes never invents blank lines", () => {
  const lines = [{ text: "a", box: null }, { text: "b", box: null }];
  assert.equal(renderText(lines), "a\nb");
});

test("expandPath resolves ~ and relative paths", () => {
  assert.ok(expandPath("~/x.png").startsWith("/"));
  assert.equal(expandPath("x.png", "/tmp/dir"), "/tmp/dir/x.png");
  assert.throws(() => expandPath(""), (error) => error instanceof OcrEngineError);
});

/* ------------------------------------------------------------ tesseract TSV */

test("parseTsv groups words into lines with mean confidence", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t10\t10\t40\t12\t96\tПривет,",
    "5\t1\t1\t1\t1\t2\t55\t10\t30\t12\t90\tмир",
    "5\t1\t1\t1\t2\t1\t10\t40\t60\t12\t80\tвторая",
  ].join("\n");
  const lines = parseTsv(tsv);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Привет, мир");
  assert.equal(Math.round(lines[0].confidence * 100) / 100, 0.93);
  assert.equal(lines[1].text, "вторая");
});

test("parseTsv tolerates a header-only payload", () => {
  assert.deepEqual(parseTsv("level\tpage_num\n"), []);
});

/* ------------------------------------------------------------------- errors */

test("a missing image is an error, not an empty result", async () => {
  const missing = join(FIXTURES, "nope.png");
  await assert.rejects(() => recognize(missing, { home: HOME }), (error) => {
    assert.equal(error.code, "not-a-file");
    return true;
  });
});

test("a directory is refused as an image", async () => {
  await assert.rejects(() => recognize(FIXTURES, { home: HOME }), /not a file/);
});

test("an explicitly requested engine that cannot run reports why", async () => {
  await assert.rejects(
    () => recognizeWithTesseract(CYRILLIC, { binary: "/nonexistent/tesseract" }),
    (error) => {
      assert.equal(error.code, "run-failed");
      assert.match(error.message, /tesseract failed/);
      return true;
    },
  );
});

test("an unknown engine name is refused", async () => {
  assert.deepEqual(ENGINES, ["auto", "vision", "tesseract"]);
  await assert.rejects(() => recognize(CYRILLIC, { engine: "ocr" }), /unknown engine/);
});

/* ------------------------------------------------------------------ macOS */

test("the Vision engine compiles once and is reused", { skip: !MACOS }, async () => {
  const first = await ensureVisionBinary({ home: HOME });
  const second = await ensureVisionBinary({ home: HOME });
  assert.equal(first, second);
  assert.ok(existsSync(first));
});

test("Vision reads Cyrillic from a real screenshot", { skip: !MACOS }, async () => {
  const result = await recognizeWithVision(CYRILLIC, { home: HOME });
  assert.equal(result.engine, "vision");
  assert.match(result.text, /Договор управления/);
  assert.match(result.text, /ИНН 7712345678/);
  assert.match(result.text, /Минимальная зарплата: 1213/);
  assert.ok(result.lines.length >= 5);
  for (const line of result.lines) {
    assert.equal(typeof line.text, "string");
    assert.ok(Number.isFinite(line.confidence) && line.confidence >= 0 && line.confidence <= 1);
  }
  assert.ok(result.lines.some((line) => line.confidence < 1), "at least one line is not certain");
});

test("an image with no text is an empty result, not an error", { skip: !MACOS }, async () => {
  const result = await recognize(BLANK, { home: HOME });
  assert.equal(result.engine, "vision");
  assert.equal(result.text, "");
  assert.deepEqual(result.lines, []);
});

test("engineStatus names the engine auto would pick", { skip: !MACOS }, async () => {
  const status = await engineStatus({ home: HOME });
  assert.equal(status.platform, "darwin");
  assert.equal(status.vision.available, true);
  assert.equal(status.selected, "vision");
});

test("the fast recogniser is Latin-only, and says so", { skip: !MACOS }, async () => {
  const accurate = await recognizeWithVision(CYRILLIC, { home: HOME, fast: true });
  assert.equal(accurate.recognizer, "fast");
  // The documented, measured behaviour: asking the fast path for Cyrillic gets
  // Latin lookalikes with no error raised — "Договор" arrives as "oroBOP".
  assert.doesNotMatch(accurate.text, /Договор/);
  assert.match(accurate.text, /oroBOP/);
  assert.match(accurate.warning, /Latin-only/);
  const slow = await recognizeWithVision(CYRILLIC, { home: HOME });
  assert.match(slow.text, /Договор/);
  assert.equal(slow.warning, undefined);
});
