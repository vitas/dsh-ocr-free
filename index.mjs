/**
 * `dsh-ocr-free` — read text out of images, locally.
 *
 * A model that declares no image input cannot be handed a screenshot: the
 * harness replaces the attachment with a text note and the pixels are gone. Two
 * answers exist for that. One is to make the host believe the model sees
 * images; the other — the one taken here — is to hand the model TEXT, which is
 * all it was ever going to get out of the picture anyway. This plugin does the
 * second: one tool, no network, no API key, no install.
 *
 * The engine is Apple Vision, compiled from `vision.swift` on first use and
 * cached under `~/.dsh-ocr-free`. Where that is not available (no command
 * line tools, or not macOS) an installed `tesseract` is used instead. When
 * neither works the tool FAILS with both reasons: an OCR tool that returns an
 * empty string would be indistinguishable from an image that holds no text.
 *
 * Deliberately absent: monkey-patching the host's model capability claims. A
 * plugin that lies about `inputModalities` changes how every request in the
 * session is assembled; a plugin that adds a tool changes nothing but the tool
 * list.
 *
 * @module dsh-ocr-free
 */

import { PACKAGE_NAME, PLUGIN_NAME, resolveConfig } from "./config.mjs";
import { engineStatus, recognize } from "./src/host/engines.js";
import { loadHostModule } from "./src/host/host-modules.js";
import { Config, readConfig } from "./src/host/index.js";

/**
 * `defineTool` comes from the host's own copy of `@deepseek-ai/dsh-tools`,
 * resolved through the host entry point — a `link:`-installed checkout cannot
 * resolve it by a bare specifier, and a second copy of the tool runtime would
 * be the wrong thing to register into anyway.
 */
const { defineTool } = await loadHostModule("@deepseek-ai/dsh-tools");

/** Plugin (row) name; also the settings namespace. */
export const name = PLUGIN_NAME;

/**
 * The `tools` service is what this plugin registers into. ToolRuntime injects
 * only `systemPrompt` itself, so without this the service is not guaranteed to
 * be mounted before `apply` runs.
 */
export const inject = ["tools"];

/** The row's volatile Config schema; the Loader applies it before `apply`. */
export { Config };

/** Milliseconds with one decimal, for the report header. */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Longest run of a single character a quoted excerpt may contain. */
const DEFAULT_MAX_CHARS = 40_000;

/**
 * Render one OCR result as the text a model reads.
 *
 * The header is not decoration: it names the engine and the timing (so a slow
 * image is visible), and it repeats any engine warning. Uncertain lines are
 * listed separately because the engine's own confidence is the only signal that
 * separates a reading from a guess — on the samples measured here, the one
 * mis-recognised letter sat on the one line that scored 0.50.
 *
 * @param result - the engine result.
 * @param options - `{ maxChars, lowConfidence, includeEngineLine }`.
 * @returns the report text.
 */
export function renderReport(result, options = {}) {
  const { maxChars = DEFAULT_MAX_CHARS, lowConfidence = 0, includeEngineLine = true } = options;
  const text = result.text ?? "";
  const lines = [];
  if (includeEngineLine) {
    lines.push(
      `[${PACKAGE_NAME}] engine=${result.engine} recognizer=${result.recognizer ?? "default"} `
      + `lines=${result.lines?.length ?? 0} time=${seconds(result.elapsedMs ?? 0)}`
      + (result.effectiveLanguages?.length ? ` languages=${result.effectiveLanguages.join(",")}` : ""),
    );
    if (result.requestedLanguages?.length && result.effectiveLanguages?.length === 0) {
      lines.push(
        `note: the engine accepted none of the requested languages (${result.requestedLanguages.join(",")}); `
        + `it detected the script itself.`,
      );
    }
    if (result.warning) lines.push(`warning: ${result.warning}`);
  }
  lines.push("=== text ===");
  if (text.length === 0) {
    lines.push("(no text recognised in this image)");
  } else if (maxChars > 0 && text.length > maxChars) {
    lines.push(text.slice(0, maxChars));
    lines.push(`[truncated: ${text.length - maxChars} more characters — raise maxChars to see them]`);
  } else {
    lines.push(text);
  }
  const uncertain = (result.lines ?? []).filter(
    (line) => lowConfidence > 0 && Number.isFinite(line.confidence) && line.confidence < lowConfidence,
  );
  if (uncertain.length > 0) {
    lines.push(`=== uncertain (confidence < ${lowConfidence}) ===`);
    for (const line of uncertain) {
      lines.push(`[${line.confidence.toFixed(2)}] ${line.text}`);
    }
  }
  return lines.join("\n");
}

/**
 * Mount the tool.
 *
 * @param ctx - host cordis context.
 * @param input - the row config: volatile accessors on 0.1.7+, plain values on
 *   older hosts. Read per call, never captured, so a settings edit takes effect
 *   on the next call without a restart.
 * @param deps - test seam: `{ recognize, engineStatus }`.
 * @returns nothing; the tool stays registered for the lifetime of the fiber.
 */
export async function apply(ctx, input = {}, deps = {}) {
  const doRecognize = deps.recognize ?? recognize;
  const doStatus = deps.engineStatus ?? engineStatus;
  /** The current configuration, resolved from the live row values. */
  const currentConfig = () => resolveConfig(readConfig(input));

  ctx.tools.register(defineTool({
    name: "ocr_image",
    description:
      "Read the text out of an image file (screenshot, photo, scan) using a LOCAL OCR engine — "
      + "no network, no API key, nothing to install. Use it when you cannot see images, or to obtain "
      + "quotable text plus the engine's own per-line confidence. Apple Vision is used by default; "
      + "`engine: \"tesseract\"` picks an installed tesseract instead (useful for Bulgarian, where "
      + "Vision on some macOS builds confuses ъ with ь). The `fast` level is Latin-only: keep it off "
      + "for Cyrillic, Greek or CJK, which come back as Latin lookalikes.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the image file (PNG, JPEG, HEIC, TIFF, GIF, BMP).",
      },
      langs: {
        type: "array",
        items: { type: "string" },
        description:
          "Preferred languages (Vision: \"ru-RU\", \"en-US\"; tesseract: \"rus\", \"bul\", \"eng\"). "
          + "Omit to use the configured value; [] asks the engine to detect the script itself.",
      },
      engine: {
        type: "string",
        enum: ["auto", "vision", "tesseract"],
        description: "Engine for this call, overriding the configured one.",
      },
      fast: {
        type: "boolean",
        description: "Use the fast recogniser for this call (~3x quicker, Latin-only).",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    // Reading an image has no side effects beyond the one-time engine build,
    // which is deduplicated, so parallel calls are safe.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const config = currentConfig();
      const started = Date.now();
      const result = await doRecognize(args.path, {
        engine: args.engine ?? config.engine,
        langs: args.langs ?? config.langs,
        fast: args.fast ?? config.fast,
        detectLanguage: config.detectLanguage,
        home: config.dir || undefined,
        timeoutMs: config.timeoutMs,
        signal: exec?.signal,
        logger: ctx.logger,
      });
      return renderReport({ ...result, elapsedMs: Date.now() - started }, {
        maxChars: config.maxChars,
        // With no confidence to show (tesseract boxes are optional) the section
        // is skipped rather than filled with zeros.
        lowConfidence: result.lines?.some((line) => Number.isFinite(line.confidence)) ? config.lowConfidence : 0,
        includeEngineLine: config.includeEngineLine,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: "ocr_status",
    description:
      "Report which local OCR engine this machine can use and why, without reading an image. "
      + "Use it when `ocr_image` reports that no engine is available.",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const config = currentConfig();
      const status = await doStatus({
        home: config.dir || undefined,
        timeoutMs: config.timeoutMs,
        logger: ctx.logger,
      });
      const report = [
        `[${PACKAGE_NAME}] platform=${status.platform} selected=${status.selected ?? "none"}`,
        `vision: available=${status.vision.available}${status.vision.languages ? ` languages=${status.vision.languages.length}` : ""}`
          + (status.vision.error ? ` error=${status.vision.error}` : ""),
        `tesseract: available=${status.tesseract.available}`
          + (status.tesseract.binary ? ` binary=${status.tesseract.binary}` : "")
          + (status.tesseract.error ? ` error=${status.tesseract.error}` : ""),
        `config: engine=${config.engine} fast=${config.fast} langs=${config.langs.length > 0 ? config.langs.join(",") : "(engine default)"}`,
      ];
      return report.join("\n");
    },
  }));
}
