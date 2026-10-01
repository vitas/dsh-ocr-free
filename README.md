# dsh-ocr-free

Local OCR for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): read the text out of
a screenshot, photo or scan **without the network and without an API key**.

On macOS the engine is Apple Vision, compiled from a 130-line Swift file on first use and cached — so
there is nothing to install either. Elsewhere an installed `tesseract` is used instead, and if neither
engine is available the tool fails and says why — it never returns an empty reading.

```
[ dsh-ocr-free ] engine=vision recognizer=accurate lines=7 time=2.0s
=== text ===
Договор управления Nº 14/2026
Чл. 50, ал. 1 - Общото сьбрание създава етажна собственост
=================================================================
```

## Why this exists

A model that declares no image input cannot be handed a picture: DSH refuses the paste before anything
is written to disk (`Model "…" does not support image input`, `MODEL_DOES_NOT_SUPPORT_IMAGES`). There
are two ways to answer that. One is to tell the host the model accepts images after all; the other is
to hand the model **text**, which is all it was going to get out of the picture anyway.

This plugin does the second, and only the second. It adds two tools and changes nothing else — no
capability claims, no prompt rewriting, no host row overrides. A plugin that lies about
`inputModalities` changes how every request in the session is assembled; a plugin that adds a tool
changes the tool list.

## Install

```bash
# from a package
dsh plugin --profile web add dsh-ocr-free

# or from a checkout (edits take effect on the next host start)
dsh plugin --profile web add link:~/git/dsh-ocr-free
```

There is no exemption to grant and no engine to install. Requires DSH `^0.2.0-rc.2` (the only version
this is verified against) and Node 22+.

| platform | engine | what you need |
| --- | --- | --- |
| macOS | Apple Vision (default) | Swift command-line tools: `xcode-select --install` |
| Linux | `tesseract` | `tesseract-ocr` from your distribution, plus language data |
| Windows | `tesseract` | **untested** — the engine lookup does not resolve `tesseract.exe` (Node does not apply `PATHEXT` when spawning), so it will report the engine as missing even when it is installed |

So the zero-install claim is a macOS claim. On Linux this is a thinner thing: a wrapper around
`tesseract` that adds the confidence section, the live settings card and errors that name their cause.

## Tools

### `ocr_image`

| argument | meaning |
| --- | --- |
| `path` *(required)* | image file: PNG, JPEG, HEIC, TIFF, GIF, BMP |
| `langs` | preferred languages (Vision `ru-RU`/`en-US`; tesseract `rus`/`bul`/`eng`). Omit for the configured value; `[]` lets the engine detect the script itself |
| `engine` | `auto` (default), `vision` or `tesseract` — per call |
| `fast` | the fast recogniser (~3× quicker, **Latin-only** — see below) |

The result is the recognised text, plus a header naming the engine and the timing, plus a separate
list of lines the engine itself scored below `lowConfidence`:

```
=== uncertain (confidence < 0.7) ===
[0.50] Чл. 50, ал. 1 - Общото сьбрание създава етажна собственост
```

That section is the point of the tool. OCR output looks equally confident whether it is right or
wrong; the engine's own score is the only thing that separates a reading from a guess, and on the
samples measured here the one mis-recognised letter sat on the one line scored 0.50.

### `ocr_status`

Reports which engine this machine can use and why, without reading an image. It does not build the
engine (a status call should not have that side effect) — it answers whether the build is already
there, whether a compiler exists, and whether tesseract is installed.

## Configuration

The plugin row is `ocr-free`; the settings card edits these fields live (no restart):

| field | default | meaning |
| --- | --- | --- |
| `engine` | `auto` | `auto` prefers Vision, falls back to tesseract; a pinned engine reports its own failure instead of silently switching |
| `langs` | `[]` | `[]` asks for nothing in particular — see the language note below |
| `fast` | `false` | the fast recogniser; **Latin-only** |
| `detectLanguage` | `false` | let Vision guess the language too; costs 0.2–0.9 s per image |
| `maxChars` | `40000` | truncate the rendered text (0 = no cap); truncation is always announced |
| `lowConfidence` | `0.7` | below this, lines are listed separately (0 = no section) |
| `timeoutMs` | `120000` | per-image engine budget |
| `dir` | `""` | engine build directory; `""` means `~/.dsh-ocr-free` |
| `includeEngineLine` | `true` | the header with engine, timing and warnings |

## Measured behaviour

Taken on macOS 15.4.1 (build 24E263), Apple silicon, against a 1000×200 crop of Cyrillic text and an
824×907 UI screenshot:

| case | time | notes |
| --- | --- | --- |
| 1000×200, `accurate` | 1.6 s | 7/7 lines correct |
| 1000×200, `accurate` + language detection | 1.8 s | identical output |
| 1000×200, `fast` | 0.5 s | **Latin lookalikes**: `Договор управления` → `oroBOP ynpaBneHMA` |
| 824×907 screenshot, `accurate` | 3.0 s | 38 lines |
| 824×907 screenshot, `accurate` + detection | 3.9 s | identical output |

Three findings worth carrying:

- **The fast recogniser is Latin-only.** Asked for Cyrillic it does not fail — it returns Latin
  homoglyphs with high confidence. This holds for every requested language, so it is a property of the
  level, not of the hint; `fast` stays off by default and the tool repeats the caveat whenever it is on.
- **Language hints do not matter for Cyrillic on this build.** Vision's *requestable* language list has
  18 entries and not one Cyrillic identifier, yet Cyrillic is read correctly by the default model
  (script detection is not gated on that list). Requesting `ru-RU` is therefore silently ignored —
  which is why `langs: []` is the honest default and why the report names the languages that actually
  took effect.
- **Bulgarian is the weak spot.** Vision on this build reads `събрание` as `сьбрание` — ъ→ь — in every
  mode tried (`accurate`, `fast`, language detection on/off, `bg-BG` forced). If you work with
  Bulgarian legal text, install `tesseract` (`brew install tesseract tesseract-lang`) and pass
  `engine: "tesseract"`; the tool will tell you if the language data is missing.

## What it deliberately does not do

- **No pasted images on a text-only route.** The host refuses such a paste up front and writes nothing
  to disk, so there is no file for any tool to read. Fixing that means claiming image capability for a
  model that declares none — a session-wide change this plugin will not make. Either give the model
  real image input (an `input:` list on its provider entry) or save the picture and pass a path.
- **No network, ever.** Nothing leaves the machine; the only subprocesses are the compiled Vision
  engine and, if selected, `tesseract`.
- **No silent failure.** A missing engine, an unreadable path, a compiler error and a missing
  tesseract language pack are all reported as tool errors with the cause.

## Verification

`node --test` — 29 tests, all passing, covering: the config contract; TSV parsing; the error paths
(missing file, directory, unavailable engine, unknown engine name); text rendering with block gaps;
and, on macOS, the real engine — compile-once-and-reuse, Cyrillic recognition from a real screenshot,
an image with no text, and the documented fast/Latin-only behaviour.

End to end on a throwaway DSH 0.2.0-rc.2 profile (`DSH_HOME=/tmp/…`): the plugin installs **without a
version exemption** (unlike plugins declaring `@deepseek-ai/dsh-tools` below `0.2.0-rc.2`), the profile
composes the row, and the host boots with it active and no load error.

Both tools were then called live by a model in a session on that profile. `ocr_status` reported
`platform=darwin selected=vision`, `vision: available=true languages=18`; `ocr_image` on the Cyrillic
fixture returned the seven lines unchanged in 1.7 s — engine compiled on first use — with the one
mis-scored line separated:

```
[dsh-ocr-free] engine=vision recognizer=accurate lines=7 time=1.7s
=== text ===
Договор управления Nº 14/2026
Чл. 50, ал. 1 - Общото сьбрание създава етажна собственост
…
=== uncertain (confidence < 0.7) ===
[0.50] Чл. 50, ал. 1 - Общото сьбрание създава етажна собственост
```

## Related work

[`dsh-ocr-local`](https://www.npmjs.com/package/dsh-ocr-local) is the other plugin in this space, and
it is a good one. It targets the *paste* flow, which requires exactly the capability claim described
above — it patches `llm.resolveModelInfo` so the admission gate lets the image through, then reads the
bytes back through `attachments.readImage()` and injects the text. Its engine is PP-OCRv5 on
ONNX Runtime: cross-platform and strong on Chinese, at the cost of a Python virtualenv and model
downloads on first use (it is also, at the time of writing, declared incompatible with DSH 0.2.0-rc.2
and therefore needs `dsh plugin allow-version --accept-risk`). Choose it when pasted images on a
text-only route are the requirement; choose this one when you want no install, no capability claim and
nothing extra in the session's request path.

## License

MIT
