// Apple Vision OCR engine for dsh-ocr-free.
//
// Compiled on first use by src/host/vision.js and invoked as a subprocess; it
// talks JSON on stdout so the host half never has to parse human-readable text.
//
//   vision-ocr <image> [language ...]      OCR the image
//   vision-ocr --fast <image> [language]   use the .fast recogniser
//   vision-ocr --detect-language <image>   let Vision guess the language too
//   vision-ocr --langs                     print the requestable languages
//
// Vision wants language identifiers ("ru-RU"), and it THROWS when asked for one
// the running OS build does not carry. Cyrillic is the interesting case: on at
// least macOS 15.4 no Cyrillic identifier is requestable at all, yet the default
// model reads Cyrillic fine (script detection is not gated on this list). So a
// requested language is honoured only when it is requestable, and the effective
// set is reported back — a silent substitution is exactly the kind of thing that
// makes an OCR result look wrong for no visible reason.

import AppKit
import Foundation
import Vision

let args = Array(CommandLine.arguments.dropFirst())

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

func supportedLanguages() -> [String] {
  (try? VNRecognizeTextRequest.supportedRecognitionLanguages(
    for: .accurate, revision: VNRecognizeTextRequestRevision3)) ?? []
}

if args.contains("--langs") {
  let payload: [String: Any] = [
    "engine": "vision",
    "supported": supportedLanguages(),
  ]
  let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

// Language detection and the recogniser level are the two dials that actually
// move the clock: on a 824x907 screenshot `accurate` spends ~3.0 s against
// ~0.5 s for `fast`, and detection adds ~0.2-0.9 s on top of either. Neither
// changed a single character of the samples measured here, so both are opt-in
// and the cheap path is the default.

var fast = false
var detectLanguage = false
var positional: [String] = []
for arg in args {
  switch arg {
  case "--fast": fast = true
  case "--detect-language": detectLanguage = true
  default: positional.append(arg)
  }
}

guard let imagePath = positional.first else {
  fail("usage: vision-ocr [--fast] [--detect-language] <image> [language ...]", code: 2)
}

let requested = Array(positional.dropFirst())
let available = supportedLanguages()
let effective = requested.filter { available.contains($0) }

guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fail("cannot read image: \(imagePath)", code: 3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = fast ? .fast : .accurate
request.usesLanguageCorrection = true
if detectLanguage, #available(macOS 13.0, *) {
  request.automaticallyDetectsLanguage = true
}
if !effective.isEmpty {
  request.recognitionLanguages = effective
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
  try handler.perform([request])
} catch {
  fail("vision request failed: \(error.localizedDescription)", code: 4)
}

var lines: [[String: Any]] = []
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let box = observation.boundingBox
  lines.append([
    "text": candidate.string,
    "confidence": Double(candidate.confidence),
    // Vision normalises with the origin at the BOTTOM-left; report top-left.
    "box": [
      "x": Double(box.minX),
      "y": Double(1 - box.maxY),
      "width": Double(box.width),
      "height": Double(box.height),
    ],
  ])
}

let payload: [String: Any] = [
  "engine": "vision",
  "recognizer": fast ? "fast" : "accurate",
  "requestedLanguages": requested,
  "effectiveLanguages": effective,
  "supportedLanguages": available,
  "lines": lines,
]
let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
