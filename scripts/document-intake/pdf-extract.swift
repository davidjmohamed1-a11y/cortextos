// pdf-extract.swift — Native macOS PDF text extraction via PDFKit.
//
// Used by scripts/document-intake/extract.sh as a fallback when
// `mdls kMDItemTextContent` returns empty (unindexed PDF, freshly-dropped,
// or images-only PDFs where mdls has no text). PDFKit is built into macOS
// so this has zero external runtime deps — matches the repo rule.
//
// Usage: swift pdf-extract.swift <path-to-pdf>
// Exits 0 with extracted text on stdout, or exits non-zero with a diagnostic
// on stderr if the PDF is unreadable / empty / non-PDF.

import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write("usage: swift pdf-extract.swift <pdf-file>\n".data(using: .utf8)!)
    exit(2)
}

let path = args[1]
guard FileManager.default.fileExists(atPath: path) else {
    FileHandle.standardError.write("pdf-extract: file not found: \(path)\n".data(using: .utf8)!)
    exit(2)
}

let url = URL(fileURLWithPath: path)
guard let doc = PDFDocument(url: url) else {
    FileHandle.standardError.write("pdf-extract: PDFKit could not open (corrupt or not-a-PDF): \(path)\n".data(using: .utf8)!)
    exit(1)
}

var out = ""
for i in 0..<doc.pageCount {
    if let page = doc.page(at: i), let s = page.string {
        out += s
        if !s.hasSuffix("\n") { out += "\n" }
    }
}

let trimmed = out.trimmingCharacters(in: .whitespacesAndNewlines)
if trimmed.isEmpty {
    FileHandle.standardError.write("pdf-extract: no extractable text (likely image-only PDF; consider OCR): \(path)\n".data(using: .utf8)!)
    exit(3)
}

print(trimmed)
