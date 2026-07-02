#!/usr/bin/env bash
# install-voice-transcription.sh — one-shot installer for the fleet-side voice
# transcription capture-channel. Idempotent: safe to re-run.
#
# Fetches + hash-verifies + installs:
#   1. whisper.cpp v1.9.1 — SOURCE tarball, compiled locally with Apple's
#      Xcode Command Line Tools (which David already has installed on this
#      Mac). Produces `~/.cortextos/bin/whisper-cli`. Source is the official
#      ggml-org/whisper.cpp repo at the pinned tag; upstream does not
#      publish a prebuilt macOS arm64 CLI binary, so build-from-source is
#      the officially-official path here.
#   2. ffmpeg 8.1.2 — evermeet.cx static macOS build. Notarized, single-
#      binary, canonical mac-static-ffmpeg source. Produces
#      `~/.cortextos/bin/ffmpeg`. Signed by evermeet's published GPG key;
#      when the key is importable + verify passes we log `gpg=verified` in
#      the manifest, otherwise SHA256 alone with `gpg=sha256-only` note.
#
# Hard-fail no-fallback: any hash mismatch aborts the install with a clear
# error. No fallback to unverified downloads. The manifest at
# `~/.cortextos/bin/MANIFEST.json` records what was installed + verified.
#
# Prereqs (all David already has): curl, tar, make, cc (via Xcode CLT), unzip.

set -euo pipefail

BIN_DIR="${HOME}/.cortextos/bin"
BUILD_DIR="${HOME}/.cortextos/build"
MANIFEST="${BIN_DIR}/MANIFEST.json"
INSTALL_LOG="${BIN_DIR}/install.log"

# --- Pins (see boss-personal approval 2026-07-02) ---------------------------
WHISPER_TAG="v1.9.1"
WHISPER_URL="https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_TAG}.tar.gz"
WHISPER_SHA256="147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447"
WHISPER_SIZE="9012805"

FFMPEG_VERSION="8.1.2"
FFMPEG_URL="https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip"
FFMPEG_SIG_URL="https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip.sig"
FFMPEG_SHA256="e91df72a1ee7c26606f90dd2dd4dcccc6a75140ff9ea6fdd50faae828b82ba69"
FFMPEG_SIZE="26037786"

# CMake — bootstrap dep for whisper.cpp v1.7+ (upstream removed the
# make-only CLI target; CMake is required to build whisper-cli). Kitware
# ships an official signed tarball with the universal macOS binaries.
CMAKE_VERSION="4.3.3"
CMAKE_URL="https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-macos-universal.tar.gz"
CMAKE_SHA256="5221a13450c7a0219a2a0d1b6c9085eb06489721fafd8488ccebc1584175d2fb"
CMAKE_SIZE="87452640"

# evermeet.cx GPG key (published on their site; fingerprint is public).
# Belt-and-suspenders: attempt import + verify, degrade to SHA256-only on
# any hiccup without failing the install (SHA256 is the load-bearing check).
EVERMEET_GPG_KEY_URL="https://evermeet.cx/pubkey.asc"

mkdir -p "${BIN_DIR}" "${BUILD_DIR}"

log() {
  echo "[install-voice] $*"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "${INSTALL_LOG}"
}

hash_verify() {
  # $1 = file path, $2 = expected sha256, $3 = friendly name
  local actual
  actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  if [ "${actual}" != "$2" ]; then
    log "HASH MISMATCH on $3: expected $2, got ${actual}"
    log "HARD-FAIL. Removing partial download."
    rm -f "$1"
    exit 1
  fi
  log "SHA256 verified for $3 ($actual)"
}

# --- WHISPER.CPP: source-tarball → build → whisper-cli ----------------------

install_cmake_local() {
  # Bootstrap CMake locally to ~/.cortextos/tools/cmake so whisper builds
  # without a system-wide install. Idempotent.
  local cmake_root="${HOME}/.cortextos/tools/cmake-${CMAKE_VERSION}"
  local cmake_bin="${cmake_root}/CMake.app/Contents/bin/cmake"
  if [ -x "${cmake_bin}" ]; then
    log "cmake already bootstrapped at ${cmake_bin}"
    export PATH="${cmake_root}/CMake.app/Contents/bin:${PATH}"
    return 0
  fi

  local tarball="${BUILD_DIR}/cmake-${CMAKE_VERSION}.tar.gz"
  log "Fetching CMake ${CMAKE_VERSION} (bootstrap build dep, ~87MB)"
  curl -fL --retry 3 --connect-timeout 30 -o "${tarball}" "${CMAKE_URL}"
  hash_verify "${tarball}" "${CMAKE_SHA256}" "CMake ${CMAKE_VERSION} tarball"

  log "Extracting CMake to ${cmake_root}"
  mkdir -p "${cmake_root}"
  tar -xzf "${tarball}" -C "${cmake_root}" --strip-components=1

  if ! "${cmake_bin}" --version >/dev/null 2>&1; then
    log "cmake sanity check failed"
    exit 1
  fi
  log "cmake bootstrapped: $("${cmake_bin}" --version | head -1)"
  export PATH="${cmake_root}/CMake.app/Contents/bin:${PATH}"
}

install_whisper() {
  local target="${BIN_DIR}/whisper-cli"
  if [ -x "${target}" ]; then
    log "whisper-cli already present at ${target}, skipping build (delete + re-run to force rebuild)"
    return 0
  fi

  install_cmake_local

  local tarball="${BUILD_DIR}/whisper-${WHISPER_TAG}.tar.gz"
  local src_dir="${BUILD_DIR}/whisper.cpp-${WHISPER_TAG#v}"

  if [ ! -f "${tarball}" ]; then
    log "Fetching whisper.cpp ${WHISPER_TAG} source"
    curl -fL --retry 3 --connect-timeout 30 -o "${tarball}" "${WHISPER_URL}"
  fi
  hash_verify "${tarball}" "${WHISPER_SHA256}" "whisper.cpp ${WHISPER_TAG} source tarball"

  log "Extracting whisper.cpp source"
  rm -rf "${src_dir}"
  tar -xzf "${tarball}" -C "${BUILD_DIR}"

  log "Compiling whisper.cpp (~2-3 min on M-series)"
  (
    cd "${src_dir}"
    cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build build --config Release -j "$(sysctl -n hw.ncpu)"
    cp "build/bin/whisper-cli" "${target}"
  )
  chmod +x "${target}"

  # Sanity-check the produced binary loads (does NOT execute a transcription;
  # just prints --help. If this fails the build is broken and we should know
  # before shipping.)
  if ! "${target}" --help >/dev/null 2>&1; then
    log "PRODUCED BINARY FAILED SANITY CHECK: ${target} --help exited nonzero"
    rm -f "${target}"
    exit 1
  fi
  log "whisper-cli installed at ${target}"
}

# --- FFMPEG: evermeet static → unzip → ffmpeg -------------------------------

install_ffmpeg() {
  local target="${BIN_DIR}/ffmpeg"
  if [ -x "${target}" ]; then
    log "ffmpeg already present at ${target}, skipping (delete + re-run to force refetch)"
    return 0
  fi

  local zipfile="${BUILD_DIR}/ffmpeg-${FFMPEG_VERSION}.zip"
  local sigfile="${BUILD_DIR}/ffmpeg-${FFMPEG_VERSION}.zip.sig"

  log "Fetching ffmpeg ${FFMPEG_VERSION} static build (evermeet.cx)"
  curl -fL --retry 3 --connect-timeout 30 -o "${zipfile}" "${FFMPEG_URL}"
  hash_verify "${zipfile}" "${FFMPEG_SHA256}" "ffmpeg ${FFMPEG_VERSION} zip"

  # Belt-and-suspenders GPG verify. Non-fatal on any error — SHA256 was
  # already verified above, GPG is bonus provenance.
  local gpg_status="sha256-only"
  if command -v gpg >/dev/null 2>&1; then
    if curl -fsSL --retry 2 --connect-timeout 15 -o "${sigfile}" "${FFMPEG_SIG_URL}" 2>/dev/null; then
      log "Attempting GPG signature verification against evermeet.cx key"
      if curl -fsSL "${EVERMEET_GPG_KEY_URL}" 2>/dev/null | gpg --import 2>/dev/null; then
        if gpg --verify "${sigfile}" "${zipfile}" 2>/dev/null; then
          gpg_status="verified"
          log "GPG signature: verified"
        else
          log "GPG signature: failed to verify — continuing on SHA256 alone"
        fi
      else
        log "GPG key import failed — continuing on SHA256 alone"
      fi
    else
      log "GPG .sig download failed — continuing on SHA256 alone"
    fi
  else
    log "gpg binary not available — SHA256-only verification"
  fi

  log "Extracting ffmpeg"
  (cd "${BIN_DIR}" && unzip -q -o "${zipfile}")
  chmod +x "${target}"

  # Sanity: ffmpeg -version returns 0.
  if ! "${target}" -version >/dev/null 2>&1; then
    log "PRODUCED BINARY FAILED SANITY CHECK: ${target} -version exited nonzero"
    rm -f "${target}"
    exit 1
  fi
  log "ffmpeg installed at ${target} (verify=${gpg_status})"
  echo "${gpg_status}" > "${BIN_DIR}/.ffmpeg-gpg-status"
}

# --- Manifest --------------------------------------------------------------

write_manifest() {
  local ffmpeg_gpg
  ffmpeg_gpg="$(cat "${BIN_DIR}/.ffmpeg-gpg-status" 2>/dev/null || echo 'sha256-only')"
  cat > "${MANIFEST}" <<JSON
{
  "schema_version": 1,
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "installer_host": "$(hostname -s)",
  "components": {
    "whisper_cli": {
      "source": "official (ggml-org/whisper.cpp)",
      "release_tag": "${WHISPER_TAG}",
      "source_url": "${WHISPER_URL}",
      "source_sha256": "${WHISPER_SHA256}",
      "build_method": "cmake or make from source",
      "binary_path": "${BIN_DIR}/whisper-cli"
    },
    "ffmpeg": {
      "source": "evermeet.cx static build (notarized, GPG-signed)",
      "version": "${FFMPEG_VERSION}",
      "download_url": "${FFMPEG_URL}",
      "download_sha256": "${FFMPEG_SHA256}",
      "gpg_verification": "${ffmpeg_gpg}",
      "binary_path": "${BIN_DIR}/ffmpeg"
    }
  }
}
JSON
  log "Manifest written: ${MANIFEST}"
}

main() {
  log "=== install-voice-transcription start ==="
  install_whisper
  install_ffmpeg
  write_manifest
  log "=== install-voice-transcription complete ==="
  echo ""
  echo "Voice-transcription capture-channel ready."
  echo "  whisper-cli: ${BIN_DIR}/whisper-cli"
  echo "  ffmpeg:      ${BIN_DIR}/ffmpeg"
  echo "  manifest:    ${MANIFEST}"
}

main "$@"
