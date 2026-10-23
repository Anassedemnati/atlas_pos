#!/usr/bin/env bash
# Linux smoke test: the packaged application (electron-builder `--linux --dir`) started on a bare
# debian:stable-slim container under Xvfb, with ATLAS_SMOKE=1. Passes when the app, on a temporary data
# directory, finishes its setup (café template, virtual printer), closes one sale, prints it and runs a backup:
# it prints `SMOKE_OK <ticketLabel> <backupSha>` and exits 0.
#
# Usage: bash scripts/smoke-linux.sh            (builds the package first)
#        SKIP_BUILD=1 bash scripts/smoke-linux.sh   (reuses release/linux-unpacked)
# Needs Docker. The image `atlas-pos-smoke` (Debian + Xvfb + Electron's system libraries) is built once and kept.
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE=atlas-pos-smoke
PLATFORM=linux/amd64
TIMEOUT_S="${SMOKE_TIMEOUT:-120}"

command -v docker >/dev/null || { echo "smoke-linux: docker is not installed" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "smoke-linux: the Docker daemon is not running (open -a Docker)" >&2; exit 2; }

if [ "${SKIP_BUILD:-}" != "1" ]; then
  npm run build
  # The shell may export ELECTRON_RUN_AS_NODE; the builder is plain Node and does not care, a launch would.
  npx electron-builder --linux --dir --publish never
fi

APP=release/linux-unpacked
BIN="$(find "$APP" -maxdepth 1 -type f -perm -u+x ! -name '*.so*' ! -name 'chrome*' ! -name '*.sh' | head -1)"
[ -n "$BIN" ] || { echo "smoke-linux: no executable in $APP (run without SKIP_BUILD)" >&2; exit 2; }

docker build --quiet --platform "$PLATFORM" -t "$IMAGE" - >/dev/null <<'DOCKERFILE'
FROM debian:stable-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb xauth libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 ca-certificates \
 || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 ca-certificates \
 ; rm -rf /var/lib/apt/lists/*
DOCKERFILE

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
echo "smoke-linux: starting $(basename "$BIN") in $IMAGE (timeout ${TIMEOUT_S}s)"
set +e
docker run --rm --platform "$PLATFORM" -v "$PWD/$APP:/opt/atlas:ro" -e ATLAS_SMOKE=1 "$IMAGE" \
  timeout "$TIMEOUT_S" xvfb-run -a "/opt/atlas/$(basename "$BIN")" --no-sandbox --disable-gpu --disable-dev-shm-usage \
  >"$LOG" 2>&1
STATUS=$?
set -e

if grep -q '^SMOKE_OK ' "$LOG" && [ "$STATUS" -eq 0 ]; then
  grep '^SMOKE_OK ' "$LOG"
  echo "smoke-linux: PASS"
else
  tail -n 60 "$LOG" >&2
  echo "smoke-linux: FAIL (exit code $STATUS)" >&2
  exit 1
fi
