/**
 * Tesseract engine — the fallback for machines without a Swift toolchain, and
 * the only engine that can be taught Bulgarian on a macOS build whose Vision
 * model lacks it.
 *
 * Tesseract is NOT bundled and NOT required: it is used only when the caller
 * asks for it (or asks for `auto` and Vision is unavailable). Its absence is
 * reported with the exact command that fixes it, never swallowed.
 *
 * @module dsh-ocr-free/tesseract
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";

import { OcrEngineError, expandPath } from "./vision.js";

const run = promisify(execFile);

/** The usual install locations, after PATH. */
const FALLBACK_PATHS = [
  "/opt/homebrew/bin/tesseract",
  "/usr/local/bin/tesseract",
  "/usr/bin/tesseract",
];

/**
 * Find a tesseract binary.
 *
 * @returns the path, or null when there is none.
 */
export async function findTesseract() {
  for (const candidate of ["tesseract", ...FALLBACK_PATHS]) {
    try {
      await run(candidate, ["--version"], { timeout: 30_000 });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Parse tesseract's TSV word rows into lines, keeping the Vision shape. */
export function parseTsv(tsv) {
  const rows = tsv.split("\n").slice(1).filter((row) => row.trim().length > 0);
  const lines = [];
  let current = null;
  for (const row of rows) {
    const columns = row.split("\t");
    if (columns.length < 12) continue;
    const [level, , block, paragraph, line, , left, top, width, height, confidence, ...rest] = columns;
    const text = rest.join("\t").trim();
    if (text.length === 0) continue;
    if (level !== "5") continue; // word level
    const key = `${block}:${paragraph}:${line}`;
    const x = Number(left);
    const y = Number(top);
    const w = Number(width);
    const h = Number(height);
    const conf = Number(confidence);
    if (current?.key !== key) {
      current = { key, words: [], confidences: [], box: { x, y, width: w, height: h } };
      lines.push(current);
    }
    current.words.push(text);
    if (Number.isFinite(conf) && conf >= 0) current.confidences.push(conf / 100);
    current.box.width = Math.max(current.box.x + current.box.width, x + w) - current.box.x;
    current.box.height = Math.max(current.box.y + current.box.height, y + h) - current.box.y;
  }
  return lines.map((line) => ({
    text: line.words.join(" "),
    confidence: line.confidences.length > 0
      ? line.confidences.reduce((sum, value) => sum + value, 0) / line.confidences.length
      : 0,
    box: null, // tesseract boxes are pixel coordinates, not normalised
    pixelBox: line.box,
  }));
}

/**
 * Recognise text with tesseract.
 *
 * @param imagePath - path to the image.
 * @param options - `{ langs, timeoutMs, binary, cwd }`.
 * @returns `{ engine: "tesseract", languages, lines, text }`.
 * @throws OcrEngineError `no-toolchain` or `run-failed`, naming the language
 *   data problem when tesseract reports one.
 */
export async function recognizeWithTesseract(imagePath, options = {}) {
  const { langs = [], timeoutMs = 120_000, binary, cwd = process.cwd(), signal } = options;
  const path = expandPath(imagePath, cwd);
  if (!existsSync(path)) throw new OcrEngineError("not-a-file", `no such image: ${path}`);
  if (!statSync(path).isFile()) throw new OcrEngineError("not-a-file", `not a file: ${path}`);

  const tesseract = binary ?? (await findTesseract());
  if (tesseract === null || tesseract === undefined) {
    throw new OcrEngineError(
      "no-toolchain",
      "tesseract is not installed; `brew install tesseract tesseract-lang` provides it.",
    );
  }
  const languages = langs.length > 0 ? langs : ["eng"];
  let stdout;
  try {
    ({ stdout } = await run(
      tesseract,
      [path, "stdout", "-l", languages.join("+"), "tsv"],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, signal },
    ));
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    const hint = /Failed loading language|Error opening data file/i.test(detail)
      ? ` — the language data for ${languages.join("+")} is missing; \`brew install tesseract-lang\` adds it.`
      : "";
    throw new OcrEngineError("run-failed", `tesseract failed on ${path}: ${detail}${hint}`);
  }
  const lines = parseTsv(stdout);
  return {
    engine: "tesseract",
    recognizer: "default",
    requestedLanguages: languages,
    effectiveLanguages: languages,
    lines,
    text: lines.map((line) => line.text).join("\n"),
  };
}
