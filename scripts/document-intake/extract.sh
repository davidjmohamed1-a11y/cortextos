#!/usr/bin/env bash
# extract.sh — Document text-extraction dispatcher.
#
# Native-only macOS tooling (no new runtime deps per repo rule):
#   .pdf         → mdls kMDItemTextContent (Spotlight-indexed) → PDFKit swift fallback
#   .doc .docx   → textutil -convert txt (built into macOS)
#   .rtf .rtfd   → textutil -convert txt
#   .html .htm   → textutil -convert txt
#   .txt .md .markdown → cat
#
# Prints extracted text to stdout, exits 0 on success.
# Exits 1 (with diagnostic on stderr) on unsupported types or extraction failure.
#
# Used by the document-intake skill (see
# templates/agent/.claude/skills/document-intake/SKILL.md).

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: extract.sh <file>" >&2
  exit 2
fi

file="$1"

if [ ! -f "$file" ]; then
  echo "extract.sh: file not found: $file" >&2
  exit 2
fi

# Lower-case extension
ext="$(echo "${file##*.}" | tr '[:upper:]' '[:lower:]')"
script_dir="$(cd "$(dirname "$0")" && pwd)"

case "$ext" in
  pdf)
    # 1. Try Spotlight-indexed text (near-instant for indexed docs).
    text="$(mdls -name kMDItemTextContent -raw "$file" 2>/dev/null || echo '(null)')"
    if [ -n "$text" ] && [ "$text" != "(null)" ]; then
      printf '%s' "$text"
      exit 0
    fi
    # 2. Fall back to PDFKit via a small Swift helper.
    if ! swift "$script_dir/pdf-extract.swift" "$file"; then
      echo "extract.sh: PDF extraction failed (image-only PDF? consider OCR)" >&2
      exit 1
    fi
    ;;
  doc|docx|rtf|rtfd|html|htm)
    # textutil converts, then read the .txt sibling
    tmp="$(mktemp -t extract).txt"
    if textutil -convert txt -stdout "$file" > "$tmp" 2>/dev/null; then
      cat "$tmp"
      rm -f "$tmp"
      exit 0
    fi
    rm -f "$tmp"
    echo "extract.sh: textutil failed on $file" >&2
    exit 1
    ;;
  txt|md|markdown|log|json|yaml|yml|csv|tsv|xml)
    cat "$file"
    ;;
  *)
    echo "extract.sh: unsupported extension: .$ext" >&2
    exit 1
    ;;
esac
