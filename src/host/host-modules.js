/**
 * Resolve the host's own packages from inside a third-party plugin.
 *
 * A plugin installed as `link:/path/to/checkout` is a symlink in the profile,
 * and Node resolves bare specifiers from the importing module's REALPATH — the
 * checkout — which has neither `@deepseek-ai/dsh-tools` nor
 * `@deepseek-ai/schemastery` in its `node_modules`. A bare import therefore
 * fails with `ERR_MODULE_NOT_FOUND` even though the host has the package loaded
 * three directories away.
 *
 * The fix is to resolve from the host entry point instead: `process.argv[1]` is
 * the `dsh` launcher, realpath'd it lands inside the host install, and a
 * `createRequire` anchored there resolves exactly the copy the host itself is
 * running — which is the copy whose types and runtime behaviour this plugin was
 * written against.
 *
 * @module dsh-ocr-free/host-modules
 */

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Every `dsh` launcher reachable on PATH, as a resolution anchor. */
function pathAnchors() {
  const anchors = [];
  const path = process.env.PATH ?? "";
  for (const entry of path.split(delimiter)) {
    if (entry.length === 0) continue;
    const candidate = join(entry, "dsh");
    if (existsSync(candidate)) anchors.push(candidate);
  }
  return anchors;
}

/**
 * Resolution anchors, best first.
 *
 * `process.argv[1]` is the launcher when the host runs normally, but it is NOT
 * always there (a test runner, an embedder) and `process.execPath` is useless
 * on a Homebrew install, where it points into the Cellar rather than at the
 * prefix that holds the global modules. The `dsh` on PATH covers both.
 */
function defaultBases() {
  const bases = [];
  if (typeof process.argv[1] === "string" && process.argv[1].length > 0) bases.push(process.argv[1]);
  bases.push(...pathAnchors());
  bases.push(join(process.cwd(), "noop.js"));
  const nodeBin = dirname(process.execPath);
  bases.push(join(nodeBin, "..", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  bases.push(join(nodeBin, "..", "..", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  return bases;
}

/** One module per specifier per process, whatever calls first. */
const cache = new Map();

/**
 * Import a host package, preferring the host's own copy.
 *
 * @param spec - the module specifier, e.g. `@deepseek-ai/dsh-tools`.
 * @param options - `{ bases }`: resolution anchors to try before the bare import.
 * @returns the module namespace.
 * @throws Error naming the last resolution failure when nothing worked.
 */
export async function loadHostModule(spec, options = {}) {
  if (cache.has(spec)) return cache.get(spec);
  const bases = options.bases ?? defaultBases();
  const attempts = bases.map((base) => async () => {
    let anchor = base;
    try {
      anchor = realpathSync(base);
    } catch {
      // A missing anchor is fine: createRequire still walks up from it.
    }
    const resolved = createRequire(anchor).resolve(spec);
    return import(pathToFileURL(resolved).href);
  });
  // Last resort: a normal bare import, for a plugin installed as a real copy
  // with the host packages beside it.
  attempts.push(() => import(spec));

  let lastError;
  for (const attempt of attempts) {
    try {
      const loaded = await attempt();
      cache.set(spec, loaded);
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `cannot load ${spec} from this plugin: ${lastError?.message ?? lastError}. `
    + "The host install may have moved; reinstall the plugin from the profile that owns this session.",
  );
}
