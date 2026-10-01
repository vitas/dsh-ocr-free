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

The first way is worth knowing too, because it is one line and it works: declare the modality on the
model entry in the profile (`input: [text, image]` for `llm-pi-ai`, `inputModalities` for the DeepSeek
provider). Measured on 2026-10-01 — with that single line, a screenshot dropped into the composer on a
hand-written b.ai route was accepted, and the model read it.

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

## Pasted images: the one-line fix

The paste flow is not closed off — it is one config line away, and on this fixture the model turned out
to be the better reader. On 2026-10-01, on a throwaway DSH 0.2.0-rc.2 profile, a hand-written b.ai route
was given a single extra field:

```yaml
          - id: deepseek-v4.1-flash
            name: DeepSeek-V4.1-Flash (b.ai)
            input: [text, image]
```

| reader of line 2 of the fixture | result |
| --- | --- |
| Apple Vision through this plugin (`accurate`, 1.7 s) | `Общото сьбрание …` — ъ read as ь, scored 0.50 and listed as uncertain |
| `deepseek-v4.1-flash` on b.ai, the image sent as an image (8 s, 16.2K tokens) | `Общото събрание …` — correct, and it also reported `№` rather than `Nº`, U+2014, `м²`, and the «» quotes |

The paste was accepted and persisted, with no `MODEL_DOES_NOT_SUPPORT_IMAGES`, and this plugin patched
nothing. What it took was knowing where the `[text]` default comes from: `llm-pi-ai` falls back to it
for model ids its catalog does not describe, and the catalog knows `deepseek-v4.1-flash` only under
Aliyun's providers — so an id on a private gateway is exactly the case that needs the line.

So if the model itself reads your images well, declare the modality and skip this plugin. Keep it for
what the model cannot cover: a file on disk read by path, no network and no key, an engine that reports
its own confidence, and a second opinion when a reading has to be checked.

Five ids on that route were then checked the same way on 2026-10-01 — `deepseek-v4.1-flash`,
`deepseek-v4-flash`, `qwen3.8-flash`, `glm-5.3-flash` and `mimo-v2.5` — and every one of them returned
the fixture's first line. A sixth could not be tested at all: its endpoint answers a different API
(`requires /v1/decisions`), so nothing was declared for it rather than guessed. Two things worth knowing
before you copy the line: a thinking model spends its budget on reasoning first (`glm-5.3-flash` read the
image correctly and still answered with an empty string at `max_tokens: 300`), and declaring `image` for
an id whose gateway does not accept images turns every request into a provider error — which is why the
line goes per model, not in a provider-wide `defaultInput`.

## What it deliberately does not do

- **No capability claims.** On a text-only route the host refuses a pasted image up front and writes
  nothing to disk, so no tool can read it. This plugin leaves that decision where it belongs — on the
  model entry, where one line settles it honestly — instead of claiming the capability for a model that
  declares none.
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

## License

MIT
