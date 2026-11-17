#!/usr/bin/env bash
# Start Pi with the extension from this directory loaded.
#
# Usage: scripts/dev.sh [--source] [--clean] [--cwd <dir>] [-- extra pi args]
#   --source     run Pi from the local checkout ($PI_SRC, default ../pi) instead of installed `pi`
#   --clean      disable all other extensions; only this one is loaded
#   --cwd <dir>  directory Pi works in (default: current directory)
#
# Inside Pi: edit index.ts, then /reload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_SRC="${PI_SRC:-$ROOT/../pi}"
USE_SOURCE=false
WORKDIR="$PWD"
PI_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) USE_SOURCE=true ;;
    --clean)  PI_ARGS+=(-ne) ;;
    --cwd)    WORKDIR="$(cd "$2" && pwd)"; shift ;;
    --)       shift; PI_ARGS+=("$@"); break ;;
    *)        PI_ARGS+=("$1") ;;
  esac
  shift
done

[[ -d "$ROOT/node_modules" ]] || (cd "$ROOT" && npm install --no-audit --no-fund)

if $USE_SOURCE; then
  [[ -d "$PI_SRC/node_modules" ]] || { echo "Run: (cd $PI_SRC && npm install)" >&2; exit 1; }
  PI_CMD=("$PI_SRC/pi-test.sh")
else
  PI_CMD=(pi)
fi

cd "$WORKDIR"
exec "${PI_CMD[@]}" -e "$ROOT" ${PI_ARGS[@]+"${PI_ARGS[@]}"}
