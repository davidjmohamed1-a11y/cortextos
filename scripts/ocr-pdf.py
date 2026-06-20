#!/usr/bin/env python3
"""
ocr-pdf.py — extract text from a PDF, using OCR when the text layer is missing
or unextractable (e.g. scanned images, subset-embedded fonts, image-only PDFs).

Default strategy:
  1. Try direct text extraction via pymupdf (fast path, works on most PDFs).
  2. If a page's extracted text is empty OR --force-ocr is set, render that
     page to an image and run RapidOCR on it.
  3. Concatenate page-by-page output, write to stdout.

Usage:
  ocr-pdf.py <input.pdf> [--force-ocr] [--page N] [--dpi 200]

Examples:
  # Auto: text layer first, OCR only pages that need it
  python3 scripts/ocr-pdf.py /path/to/some.pdf

  # Force OCR on every page (e.g. for W2s with subset-font no-text-layer)
  python3 scripts/ocr-pdf.py /path/to/some.pdf --force-ocr

  # Single page
  python3 scripts/ocr-pdf.py /path/to/some.pdf --page 1 --force-ocr

Output is plain text on stdout. Empty pages are marked with a comment line so
downstream parsers can re-split by page when needed.

Dependencies (installed via `pip3 install --user pymupdf rapidocr-onnxruntime`):
  - pymupdf (PDF parse + rasterize)
  - rapidocr-onnxruntime (OCR via ONNX runtime, no PyTorch / no system tesseract)

Tooling notes:
  - First OCR call downloads ~50MB of ONNX model weights to ~/.local/share/rapidocr_onnxruntime/
    or similar. One-time, cached after.
  - Pure-Python install path; no Homebrew or system binaries required.
"""

import argparse
import io
import sys
from typing import List, Optional

import fitz  # pymupdf


def render_page_to_png(page, dpi: int) -> bytes:
    matrix = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    return pix.tobytes("png")


def ocr_image_bytes(image_bytes: bytes, ocr) -> str:
    # rapidocr_onnxruntime API: pass raw bytes or a numpy array; returns
    # (results_or_None, time_dict). Each result is [box, text, confidence].
    result, _ = ocr(image_bytes)
    if not result:
        return ""
    return "\n".join(line[1] for line in result if line and len(line) > 1)


def extract_text(path: str, force_ocr: bool, only_page: Optional[int], dpi: int) -> str:
    doc = fitz.open(path)
    ocr = None  # lazy-load only when needed (skips heavy OCR model load on text-only PDFs)
    out_pages: List[str] = []

    pages_iter = (
        [doc[only_page - 1]]
        if only_page is not None
        else doc
    )

    for idx, page in enumerate(pages_iter, start=1 if only_page is None else only_page):
        text_layer = (page.get_text() or "").strip() if not force_ocr else ""

        if text_layer:
            out_pages.append(f"# --- Page {idx} (text layer) ---\n{text_layer}")
            continue

        # Need OCR — lazy-load
        if ocr is None:
            from rapidocr_onnxruntime import RapidOCR
            ocr = RapidOCR()

        image_bytes = render_page_to_png(page, dpi=dpi)
        ocr_text = ocr_image_bytes(image_bytes, ocr)
        if ocr_text:
            out_pages.append(f"# --- Page {idx} (OCR) ---\n{ocr_text}")
        else:
            out_pages.append(f"# --- Page {idx} (empty: no text layer, OCR returned nothing) ---")

    doc.close()
    return "\n\n".join(out_pages)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract text from a PDF using direct extraction + OCR fallback.",
    )
    parser.add_argument("pdf_path", help="Path to PDF file")
    parser.add_argument(
        "--force-ocr",
        action="store_true",
        help="Skip text-layer extraction; OCR every page (use for image-only or subset-font PDFs)",
    )
    parser.add_argument(
        "--page",
        type=int,
        default=None,
        help="Process only this single 1-indexed page",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=200,
        help="Rasterization DPI for OCR pages (default 200; higher = slower + larger images, more accurate OCR)",
    )
    args = parser.parse_args()

    try:
        text = extract_text(args.pdf_path, args.force_ocr, args.page, args.dpi)
    except FileNotFoundError:
        print(f"ERROR: PDF not found: {args.pdf_path}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 1

    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
