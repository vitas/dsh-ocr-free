/**
 * Apple Vision engine: build once, then run.
 *
 * There is nothing to install. macOS ships the Vision framework, and the OCR
 * program in `vision.swift` is compiled into `~/.dsh-ocr-vision/bin/` on first
 * use (a few seconds) and reused afterwards. The binary name carries a hash of
 * the source, so an upgraded plugin compiles its own copy instead of running a
 * stale engine — no separate cache-invalidation step to get wrong.
 *
 * Every failure is reported. An OCR tool that returns an empty string when its
 * engine is missing is worse than one that returns nothing at all: the caller
 * cannot tell "this image has no text" from "I never read the image".
 *
 * @module dsh-ocr-vision/vision
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The packaged Swift source, resolved next to this module. */
export const VISION_SOURCE = fileURLToPath(new URL("./vision.swift", import.meta.url));

/** Where the compiled engine and its stamp live. */
export function engineRoot(home = homedir()) {
  return join(home, ".dsh-ocr-vision");
}

/** An engine failure the caller can report verbatim. */
export class OcrEngineError extends Error {
  /**
   * @param code - `unsupported-platform`, `no-toolchain`, `compile-failed`,
   *   `not-a-file`, `run-failed`.
   * @param message - human-readable cause, no advice beyond the next step.
   */
  constructor(code, message) {
    super(message);
    this.name = "OcrEngineError";
    this.code = code;
  }
}

/** One compile per binary path, however many calls race for it. */
const builds = new Map();

/** Short content hash, so a changed source compiles a fresh binary. */
async function sourceHash(source = VISION_SOURCE) {
  return createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 12);
}

/**
 * Where the engine for the current source lives, compiled or not.
 *
 * @param options - `{ home, source }`.
 * @returns the absolute binary path.
 */
export async function visionBinaryPath(options = {}) {
  const { home = homedir(), source = VISION_SOURCE } = options;
  return join(engineRoot(home), "bin", `vision-ocr-${await sourceHash(source)}`);
}

/**
 * Locate a usable Swift compiler.
 *
 * PATH comes first so a version manager can win; the fixed locations cover a
 * host process whose PATH (a GUI-launched app, a launchd job) never saw the
 * toolchain.
 *
 * @returns the compiler path.
 * @throws OcrEngineError `no-toolchain` when none answers.
 */
export async function findCompiler() {
  const candidates = ["swiftc", "/usr/bin/swiftc"];
  const failures = [];
  for (const candidate of candidates) {
    try {
      await run(candidate, ["--version"], { timeout: 60_000 });
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${error?.code ?? error?.message ?? error}`);
    }
  }
  throw new OcrEngineError(
    "no-toolchain",
    `no Swift compiler found (tried ${candidates.join(", ")}): ${failures.join("; ")}. `
    + "Install the command line tools with `xcode-select --install`, or set engine to \"tesseract\".",
  );
}

/**
 * Path of the compiled engine for the current source, compiling it if needed.
 *
 * @param options - `{ home, source, timeoutMs, logger }`.
 * @returns the absolute path of an executable binary.
 * @throws OcrEngineError on a non-macOS platform or a failed compile.
 */
export async function ensureVisionBinary(options = {}) {
  const { home = homedir(), source = VISION_SOURCE, timeoutMs = 180_000, logger } = options;
  if (process.platform !== "darwin") {
    throw new OcrEngineError(
      "unsupported-platform",
      `Apple Vision needs macOS (this is ${process.platform}); the tesseract engine works elsewhere.`,
    );
  }
  const hash = await sourceHash(source);
  const binary = join(engineRoot(home), "bin", `vision-ocr-${hash}`);
  if (existsSync(binary)) return binary;
  if (builds.has(binary)) return builds.get(binary);

  const build = (async () => {
    const compiler = await findCompiler();
    mkdirSync(dirname(binary), { recursive: true });
    const staging = `${binary}.${process.pid}.tmp`;
    try {
      await run(compiler, ["-O", "-suppress-warnings", source, "-o", staging], { timeout: timeoutMs });
      renameSync(staging, binary);
    } catch (error) {
      try { unlinkSync(staging); } catch { /* nothing staged */ }
      const detail = String(error?.stderr ?? error?.message ?? error).trim().split("\n").slice(-4).join(" | ");
      throw new OcrEngineError("compile-failed", `compiling the Vision engine failed: ${detail}`);
    }
    logger?.info?.(`dsh-ocr-vision: compiled the Vision engine at ${binary}`);
    return binary;
  })();
  builds.set(binary, build);
  try {
    return await build;
  } catch (error) {
    builds.delete(binary);
    throw error;
  }
}

/** Resolve `~` and make a path absolute against the current directory. */
export function expandPath(path, cwd = process.cwd()) {
  if (typeof path !== "string" || path.length === 0) {
    throw new OcrEngineError("not-a-file", "no image path given");
  }
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : join(cwd, expanded);
}

/**
 * Recognise text in one image file.
 *
 * @param imagePath - path to the image (any format NSImage reads: PNG, JPEG, HEIC, TIFF, GIF, BMP).
 * @param options - `{ home, langs, fast, timeoutMs, logger, source }`.
 * @returns `{ engine, recognizer, requestedLanguages, effectiveLanguages, lines, text }`,
 *   where each line carries `text`, `confidence` and a top-left `box`.
 * @throws OcrEngineError when the image or the engine is unusable.
 */
export async function recognizeWithVision(imagePath, options = {}) {
  const {
    home = homedir(), langs = [], fast = false, detectLanguage = false,
    timeoutMs = 120_000, logger, source = VISION_SOURCE, signal,
  } = options;
  const path = expandPath(imagePath);
  if (!existsSync(path)) throw new OcrEngineError("not-a-file", `no such image: ${path}`);
  if (!statSync(path).isFile()) throw new OcrEngineError("not-a-file", `not a file: ${path}`);

  const binary = await ensureVisionBinary({ home, source, timeoutMs, logger });
  const argv = [
    ...(fast ? ["--fast"] : []),
    ...(detectLanguage ? ["--detect-language"] : []),
    path,
    ...langs,
  ];
  let stdout;
  try {
    ({ stdout } = await run(binary, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, signal }));
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new OcrEngineError("run-failed", `the Vision engine failed on ${path}: ${detail}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OcrEngineError("run-failed", `the Vision engine returned unreadable output for ${path}: ${stdout.slice(0, 200)}`);
  }
  const lines = (parsed.lines ?? []).map((line) => ({
    text: String(line.text ?? ""),
    confidence: Number(line.confidence ?? 0),
    box: line.box ?? null,
  }));
  // The .fast recogniser on this macOS build carries a Latin-only model: asked
  // for Cyrillic it returns Latin lookalikes ("Договор" -> "oroBOP"), with high
  // confidence and no error. Measured across every requested language, so this
  // is a property of the level, not of the language hint — say so instead of
  // letting the caller quote gibberish as a reading.
  const warning = fast
    ? "fast recogniser is Latin-only on this platform: non-Latin scripts (Cyrillic, Greek, CJK) "
      + "come back as Latin lookalikes. Use the default accurate level for them."
    : undefined;
  return { ...parsed, lines, text: renderText(lines), ...(warning ? { warning } : {}) };
}

/** The languages this macOS build accepts as an explicit request. */
export async function visionLanguages(options = {}) {
  const { home = homedir(), timeoutMs = 120_000, logger, source = VISION_SOURCE } = options;
  const binary = await ensureVisionBinary({ home, source, timeoutMs, logger });
  const { stdout } = await run(binary, ["--langs"], { timeout: timeoutMs });
  return JSON.parse(stdout).supported ?? [];
}

/**
 * Join recognised lines into text.
 *
 * Vision returns one entry per recognised text line, in reading order. A blank
 * line is inserted where the vertical gap between neighbouring lines is much
 * larger than the line height, which keeps forms, tables and address blocks
 * legible instead of collapsing them into one paragraph.
 *
 * @param lines - recognised lines with `box` (top-left normalised).
 * @param options - `{ gapFactor }`: gap/height ratio that starts a new block.
 * @returns the joined text.
 */
export function renderText(lines, options = {}) {
  const { gapFactor = 1.6 } = options;
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = lines[index - 1];
    if (previous?.box && line.box) {
      const previousBottom = previous.box.y + previous.box.height;
      const gap = line.box.y - previousBottom;
      const height = Math.max(line.box.height, previous.box.height, 1e-6);
      if (gap > height * gapFactor) out.push("");
    }
    out.push(line.text);
  }
  return out.join("\n");
}
