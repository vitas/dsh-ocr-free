# Changelog

## 0.1.0

First release: two tools, no install step, no network.

- **`ocr_image`** — recognise text in an image file and return it as text, with a header naming the
  engine and the timing, and a separate list of lines the engine scored below `lowConfidence`. The
  confidence list is the point: OCR output reads equally well whether it is right or wrong, and the
  engine's own score is the only thing distinguishing a reading from a guess.
- **`ocr_status`** — report which engine this machine can use and why, without reading an image and
  without the side effect of building the engine.
- **Engine** — Apple Vision, compiled from `src/host/vision.swift` on first use into
  `~/.dsh-ocr-vision/bin/vision-ocr-<source hash>` and reused; `tesseract` is the fallback when the
  Swift toolchain or macOS is missing. Every failure (no engine, unreadable path, compile error,
  missing tesseract language data) is a tool error naming its cause — never an empty reading.
- **Config** — volatile row schema, so the settings card edits apply to the next call without a host
  restart; every field carries its default in the schema, because a profile patch replaces the row
  config wholesale rather than merging it.
- **Compatibility** — declares `@deepseek-ai/dsh-tools` at `^0.2.0-rc.2 || >=0.1.0-rc.6 <0.2.0`, so
  DSH 0.2.0-rc.2 installs it without a version exemption; host packages are resolved through the host
  entry point (and the `dsh` on PATH), so a `link:`-installed checkout behaves like a published copy.

Measured while building it, and written into the code as comments:

- the `fast` recogniser is **Latin-only** on macOS 15.4.1 — asked for Cyrillic it returns Latin
  homoglyphs with high confidence instead of failing (`Договор управления` → `oroBOP ynpaBneHMA`), in
  every requested language. `fast` is therefore off by default, and the result carries the caveat;
- Vision reads Cyrillic correctly with **no** language hint, even though no Cyrillic identifier is
  requestable on that build (18 requestable languages, none Cyrillic) — so `langs: []` is the default
  and the report states which languages actually took effect;
- Bulgarian is the weak spot: `събрание` → `сьбрание` in every mode tried, which is what the
  tesseract fallback is for;
- cost, for honesty: 1.6 s (`accurate`) and 0.5 s (`fast`) on a 1000×200 crop; 3.0 s and 3.9 s (with
  language detection) on an 824×907 screenshot.

Deliberately absent: any monkey-patching of the host's model capability claims. A pasted image on a
text-only route is refused by the host before anything is written to disk, and getting past that means
claiming image support for a model that declares none — a session-wide change to request assembly that
this plugin will not make. Text extraction is what it offers instead.
