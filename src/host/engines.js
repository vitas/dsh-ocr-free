/**
 * Engine selection for dsh-ocr-vision.
 *
 * Two engines, one result shape. `auto` prefers Apple Vision (no install, best
 * accuracy on screenshots) and falls back to tesseract; an explicit choice is
 * honoured even when the other engine would have been the better bet, because
 * "try Vision first" is a policy, not a fact about the image.
 *
 * When both engines fail, the caller gets BOTH reasons. Reporting only the last
 * one turns a fixable setup problem ("install the command line tools") into a
 * mystery.
 *
 * @module dsh-ocr-vision/engines
 */

import { existsSync } from "node:fs";

import {
  OcrEngineError, findCompiler, recognizeWithVision, visionBinaryPath, visionLanguages,
} from "./vision.js";
import { findTesseract, recognizeWithTesseract } from "./tesseract.js";

/** Recognised engine ids. */
export const ENGINES = ["auto", "vision", "tesseract"];

/** True when an error means "this engine cannot run here at all". */
function isUnavailable(error) {
  return error instanceof OcrEngineError
    && ["unsupported-platform", "no-toolchain", "compile-failed"].includes(error.code);
}

/**
 * Recognise text in one image, choosing the engine.
 *
 * @param imagePath - path to the image.
 * @param options - `{ engine, langs, fast, home, timeoutMs, tesseractPath, cwd, logger }`.
 * @returns `{ engine, lines, text, requestedLanguages, effectiveLanguages }`.
 * @throws OcrEngineError when no usable engine could read the image.
 */
export async function recognize(imagePath, options = {}) {
  const { engine = "auto", logger, ...rest } = options;
  if (!ENGINES.includes(engine)) {
    throw new OcrEngineError("run-failed", `unknown engine "${engine}"; use one of ${ENGINES.join(", ")}`);
  }

  if (engine === "tesseract") {
    return recognizeWithTesseract(imagePath, { binary: rest.tesseractPath, ...rest });
  }

  const visionAttempt = async () => recognizeWithVision(imagePath, rest);
  if (engine === "vision") return visionAttempt();

  try {
    return await visionAttempt();
  } catch (visionError) {
    if (!isUnavailable(visionError)) throw visionError;
    logger?.warn?.(`dsh-ocr-vision: Vision unavailable (${visionError.code}: ${visionError.message}); trying tesseract`);
    try {
      return await recognizeWithTesseract(imagePath, { binary: rest.tesseractPath, ...rest });
    } catch (tesseractError) {
      throw new OcrEngineError(
        "no-toolchain",
        `no usable OCR engine. Apple Vision: ${visionError.message} Tesseract: ${tesseractError.message}`,
      );
    }
  }
}

/**
 * Report what this machine can actually do, without reading an image.
 *
 * @param options - `{ home, timeoutMs, tesseractPath, logger, compile }`.
 *   `compile: false` answers without building the engine — a status call must
 *   not have the side effect of a slow toolchain build.
 * @returns `{ platform, vision, tesseract, selected }` — each engine entry
 *   carries `available` plus either a binary/language list or the reason it is
 *   unavailable.
 */
export async function engineStatus(options = {}) {
  const { home, timeoutMs, tesseractPath, logger, compile = true } = options;
  const status = {
    platform: process.platform,
    vision: { available: false },
    tesseract: { available: false },
    selected: null,
  };

  if (compile) {
    try {
      const languages = await visionLanguages({ home, timeoutMs, logger });
      status.vision = { available: true, languages };
    } catch (error) {
      status.vision = { available: false, error: String(error?.message ?? error) };
    }
  } else {
    try {
      const binary = await visionBinaryPath({ home });
      const compiler = await findCompiler();
      status.vision = {
        available: true,
        built: existsSync(binary),
        binary,
        compiler,
      };
    } catch (error) {
      status.vision = { available: false, error: String(error?.message ?? error) };
    }
  }

  const tesseract = tesseractPath ?? (await findTesseract());
  status.tesseract = tesseract
    ? { available: true, binary: tesseract }
    : { available: false, error: "tesseract is not installed" };

  status.selected = status.vision.available ? "vision" : (status.tesseract.available ? "tesseract" : null);
  return status;
}
