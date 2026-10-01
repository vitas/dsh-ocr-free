/**
 * Host-side schema for dsh-ocr-vision.
 *
 * DSH 0.1.7+ made a plugin's settings surface the `Config` of its own Loader
 * row: the loader validates the row config against this export and the settings
 * service projects its VOLATILE fields into the Plugins row page. Both halves
 * matter:
 *
 * - A schema with no volatile field is dropped from `describe` entirely — no
 *   namespace, no Configure control, and every write through the row page is
 *   rejected.
 * - A volatile field arrives in `apply` as a live accessor (`{ get() }`), not as
 *   a value, so reading it as a scalar yields the accessor object — which looks
 *   exactly like an absent field and silently falls back to the schema default.
 *   {@link readConfig} unwraps it, and unwrapping on every call is what makes a
 *   settings edit reach the next tool call without a restart.
 *
 * Every field carries its shipped default. A profile patch that addresses this
 * row by id REPLACES the row config the bundle layer inserted (they do not
 * merge), so for anyone who has ever edited this plugin, the row config is
 * exactly the handful of fields that edit wrote; everything else can only come
 * back from these defaults. A field declared without one comes back missing, and
 * a missing `engine` would mean "no engine", not "the shipped engine".
 *
 * @module dsh-ocr-vision/host
 */

import { ENGINE_IDS, defaults } from "../../config.mjs";
import { loadHostModule } from "./host-modules.js";

/** The shipped defaults, read from the resolver so the two cannot drift. */
function shipped() {
  const d = defaults();
  return {
    engine: d.engine,
    langs: structuredClone(d.langs),
    fast: d.fast,
    detectLanguage: d.detectLanguage,
    maxChars: d.maxChars,
    lowConfidence: d.lowConfidence,
    timeoutMs: d.timeoutMs,
    includeEngineLine: d.includeEngineLine,
  };
}

/**
 * Build the row schema.
 *
 * @param z - the schemastery module.
 * @param volatile - mark every field `.volatile()`.
 * @returns the object schema.
 */
function makeSchema(z, volatile) {
  const mark = (schema) => (volatile && typeof schema.volatile === "function" ? schema.volatile() : schema);
  const d = shipped();
  return z.object({
    engine: mark(z.union(ENGINE_IDS.map((id) => z.const(id))).default(d.engine)),
    // [] means "ask the engine for nothing in particular". On macOS 15.4 no
    // Cyrillic language is requestable at all, so a pinned default would be a
    // lie the engine silently ignores.
    langs: mark(z.array(z.string()).default(d.langs)),
    fast: mark(z.boolean().default(d.fast)),
    detectLanguage: mark(z.boolean().default(d.detectLanguage)),
    maxChars: mark(z.number().step(1).min(0).max(1_000_000).default(d.maxChars)),
    lowConfidence: mark(z.number().min(0).max(1).default(d.lowConfidence)),
    timeoutMs: mark(z.number().step(1).min(1000).max(600_000).default(d.timeoutMs)),
    // Engine build directory; an empty string means ~/.dsh-ocr-vision.
    dir: mark(z.string()),
    includeEngineLine: mark(z.boolean().default(d.includeEngineLine)),
  });
}

/** Both schemas, or undefined when the optional schemastery peer is absent. */
async function buildSchemas() {
  try {
    // Through the host entry point, not a bare import: a `link:`-installed
    // checkout cannot resolve the host's own packages (see host-modules.js).
    const { default: z } = await loadHostModule("@deepseek-ai/schemastery");
    return { config: makeSchema(z, true), plain: makeSchema(z, false) };
  } catch {
    return { config: undefined, plain: undefined };
  }
}

const SCHEMAS = await buildSchemas();

/** The volatile schema the Loader applies to this row before `apply`. */
export const Config = SCHEMAS.config;

/** The same shape without the volatile marker (tests and diagnostics). */
export const PlainConfig = SCHEMAS.plain;

/**
 * Read one resolved config field.
 *
 * @param value - one field of the loader-resolved config.
 * @returns the live value behind the accessor, or the value itself.
 */
export function readField(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

/**
 * Project a whole resolved config through {@link readField}.
 *
 * @param config - the loader-resolved config (accessors, values, or a mix).
 * @returns a plain object of current values.
 */
export function readConfig(config) {
  if (config === null || typeof config !== "object") return {};
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, readField(value)]));
}
