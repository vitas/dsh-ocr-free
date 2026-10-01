/**
 * `dsh-ocr-vision` — configuration.
 *
 * The single configuration source is the plugin row's `config`: the bundle
 * patch ships defaults, the profile patch overrides the same row by id, and an
 * edit through the Plugins row page reaches the running plugin without a
 * restart because every field of the row schema is volatile and re-read per
 * call.
 *
 * Defaults are deliberately cheap and honest:
 *
 * - `accurate` recognition, no language detection. Both dials were measured on
 *   this machine (a 824x907 screenshot: ~3.0 s accurate vs ~0.5 s fast; adding
 *   detection costs another 0.2-0.9 s) and neither changed a character of the
 *   samples, so the fast paths are the opt-in ones.
 * - `langs: []` asks the engine for nothing in particular, which is the only
 *   setting that works everywhere: on macOS 15.4 no Cyrillic language is even
 *   requestable, yet Cyrillic is read correctly. Pinning `["ru-RU"]` there
 *   would silently be ignored, so the empty default is the truthful one.
 * - `lowConfidence: 0.7` marks results the engine itself doubts. This is the
 *   one signal that tells a caller "do not quote this line as fact" — on the
 *   samples here the Bulgarian line scored 0.50 exactly where it mis-recognised
 *   a letter.
 *
 * @module dsh-ocr-vision/config
 */

/** Row id and settings namespace. */
export const PLUGIN_NAME = "ocr-vision";
/** Published package name. */
export const PACKAGE_NAME = "dsh-ocr-vision";
/** Provenance stamped onto anything this plugin injects into a session. */
export const PLUGIN_SOURCE_KIND = `plugin:${PLUGIN_NAME}`;

/** Engine ids accepted by the `engine` field. */
export const ENGINE_IDS = ["auto", "vision", "tesseract"];

/** Deep-merge plain objects; arrays and scalars replace. */
export function mergeDefaults(defaults, input) {
  if (input === undefined || input === null) return structuredClone(defaults);
  if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)
    || typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const out = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    out[key] = key in defaults ? mergeDefaults(defaults[key], value) : value;
  }
  return out;
}

/** The shipped configuration. */
export function defaults() {
  return {
    // --- engine ----------------------------------------------------------
    engine: "auto",
    /** Preferred languages handed to the engine; [] asks for the engine default. */
    langs: [],
    /**
     * `.fast` recognition: ~3x quicker (0.5 s vs 1.8 s on a 1000x200 crop),
     * but LATIN-ONLY. Measured against every requested language on macOS 15.4,
     * the fast path has no Cyrillic model and returns Latin lookalikes with high
     * confidence instead of failing: "Договор управления" comes back as
     * "oroBOP ynpaBneHMA". Keep it false for anything that is not Latin script;
     * the tool reports the caveat whenever it is on.
     */
    fast: false,
    /** Let Vision guess the language as well; costs 0.2-0.9 s per image. */
    detectLanguage: false,
    /** Truncate the rendered text at this many characters; 0 disables the cap. */
    maxChars: 40_000,
    /** Lines below this confidence are reported as uncertain; 0 disables. */
    lowConfidence: 0.7,
    /** Per-image engine timeout. */
    timeoutMs: 120_000,
    /** Engine build/output directory; null means `~/.dsh-ocr-vision`. */
    dir: null,
    /** Add the engine/timing footer to the tool result. */
    includeEngineLine: true,
  };
}

/**
 * Validate a resolved configuration, loudly.
 *
 * A broken configuration must fail at composition rather than silently degrade
 * into "no text recognised": an OCR tool that quietly does nothing is exactly
 * the failure this plugin exists to avoid repeating.
 *
 * @param config - merged configuration.
 * @returns the same object.
 * @throws Error naming the first structural problem.
 */
export function validate(config) {
  const where = `${PACKAGE_NAME} config`;
  if (!ENGINE_IDS.includes(config.engine)) {
    throw new Error(`${where}: engine must be one of ${ENGINE_IDS.join(", ")}`);
  }
  if (!Array.isArray(config.langs) || !config.langs.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`${where}: langs must be an array of language identifiers such as "ru-RU" or "eng"`);
  }
  for (const key of ["fast", "detectLanguage", "includeEngineLine"]) {
    if (typeof config[key] !== "boolean") throw new Error(`${where}: ${key} must be a boolean`);
  }
  if (!Number.isFinite(config.maxChars) || config.maxChars < 0) {
    throw new Error(`${where}: maxChars must be a number >= 0`);
  }
  if (!Number.isFinite(config.lowConfidence) || config.lowConfidence < 0 || config.lowConfidence > 1) {
    throw new Error(`${where}: lowConfidence must be in [0, 1]`);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000) {
    throw new Error(`${where}: timeoutMs must be a number >= 1000`);
  }
  if (config.dir !== null && config.dir !== "" && typeof config.dir !== "string") {
    throw new Error(`${where}: dir must be a directory path, or null/"" for ~/.dsh-ocr-vision`);
  }
  return config;
}

/**
 * Merge the row config over the defaults and validate.
 *
 * @param input - the cordis row config (may be undefined).
 * @returns validated, fully-populated configuration.
 */
export function resolveConfig(input = {}) {
  return validate(mergeDefaults(defaults(), input ?? {}));
}
