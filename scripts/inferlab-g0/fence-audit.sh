#!/usr/bin/env bash
# G0 fence audit (FAC-215): the clean InferOS baseline carries none of the archived fork's legacy
# operational frameworks: Consoles, Dots, widget/workspace kinds, Operate or canvas state.
#
#   import:  tracked file paths and tracked source text (git ls-files / git grep)
#   build:   what `pnpm build` produced (packages/*/dist, packages/*/.wrangler/validate)
#   runtime: every wrangler*.json[c] under the tree, tracked or not: the committed configs and the
#            untracked wrangler.dev.jsonc files a dev-server run writes (root, workshop-backend,
#            each gatekeeper). Parsed, not grepped: bindings, classes, migrations, services, vars
#
# Exit status, and the last line, fail closed:
#   0  RESULT: clean   every level ran and found nothing
#   1  RESULT: hits    every level ran, and at least one found a fenced name
#   2  RESULT: error   a level could not run or did not finish (a missing root, an unreadable file,
#                      a malformed config, a missing build): never reported as clean or as hits
#
# The identifiers are the fork's own names (inferOS archive/main-2026-11-14), not plain words:
# "console" and "canvas" alone are everywhere in upstream code (console.log, the HTML canvas).
# Run from the repository root:  bash scripts/inferlab-g0/fence-audit.sh
# FENCE_ROOT=<a git checkout> audits that tree instead, with this script's helpers (controls).
set -u
LIB="$(cd "$(dirname "$0")" && pwd)/fence-lib.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

hits=0; errors=0
section() { printf '\n## %s\n' "$1"; }
fail() { printf -- '-> %s: SCANNER ERROR (%s)\n' "$1" "$2"; errors=$((errors + 1)); }
finish() {
  if [ "$errors" -gt 0 ]; then printf '\nRESULT: error (%s scanner error(s); nothing is claimed clean)\n' "$errors"; exit 2; fi
  if [ "$hits" -gt 0 ]; then printf '\nRESULT: hits (%s level(s) with hits)\n' "$hits"; exit 1; fi
  printf '\nRESULT: clean (0 levels with hits)\n'; exit 0
}
# Print the hits in $TMP/$2 under label $1, counting a level with any.
report() {
  if [ -s "$TMP/$2" ]; then
    cat "$TMP/$2"; printf -- '-> %s: %s hit(s)\n' "$1" "$(wc -l < "$TMP/$2" | tr -d ' ')"; hits=$((hits + 1))
  else
    printf -- '-> %s: none\n' "$1"
  fi
}

ROOT="${FENCE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "$ROOT" ] || ! cd "$ROOT" 2>/dev/null; then
  section "setup"; fail "audit root" "cannot enter '${ROOT:-<none>}'"; finish
fi
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  section "setup"; fail "audit root" "'$ROOT' is not a git checkout"; finish
fi

# Paths only the fork had.
PATH_PATTERN='features/(operate|operate-publish|canvas|workspace-kind)/|pages/inferops-canvas|canvas-model|temporary-canvas|workspace-kind|operate-session|custom-gatekeepers/|gatekeeper-inferops|blueprints/inferops-|scripts/consumer/|scripts/local/|inferos\.canvas\.json|dot-relay|/dot(\.|-)'

# Identifiers only the fork had. Every term is checked case-sensitively as written.
CONTENT_PATTERN='OperateSession|operate-session|operateSession|OperateMode|operate-publish|features/operate|features/canvas|CanvasModel|canvas-model|canvasModel|TemporaryCanvas|temporary-canvas|WorkspaceKind|workspace-kind|workspaceKind|inferos\.canvas\.json|inferops-canvas|InferopsCanvas|gatekeeper-inferops|custom-gatekeepers|inferops-dot|DotRuntime|dot-runtime|dot-relay|DotRelay|OpenDots|ConsoleWidget|console-widget|consoleWidget|WidgetKind|widget-kind|widgetKind|scripts/consumer|scripts/local/lifecycle|SHARED_CONFIGURATION_GATEKEEPER|mock-inferops|demo\.local'

# This file and the G0 report quote the patterns themselves.
SELF=':!scripts/inferlab-g0/' ; REPORT=':!docs/inferlab-g0.md'
# Provenance, not code. gatekeeper-inferlab's README is the port ledger (what was taken from the fork
# and what was left behind): excluded by file. Its two "Ported from the archived fork" source comments
# (and their build copies) are excluded as exact whole lines by fence-lib.mjs, so anything else on
# such a line still counts.
LEDGER=':!packages/gatekeeper-inferlab/README.md'

section "import: tracked paths"
if ! git ls-files > "$TMP/files" 2> "$TMP/err"; then
  fail "tracked paths" "git ls-files: $(head -1 "$TMP/err")"
else
  grep -E "$PATH_PATTERN" "$TMP/files" > "$TMP/path-hits"; st=$?
  if [ "$st" -ge 2 ]; then fail "tracked paths" "grep exited $st"; else report "tracked paths" path-hits; fi
fi

section "import: tracked source text"
git grep -nE "$CONTENT_PATTERN" -- . "$SELF" "$REPORT" "$LEDGER" > "$TMP/text-raw" 2> "$TMP/err"; st=$?
if [ "$st" -ge 2 ]; then
  fail "tracked source text" "git grep exited $st: $(head -1 "$TMP/err")"
elif ! node "$LIB" filter < "$TMP/text-raw" > "$TMP/text-hits" 2> "$TMP/err"; then
  fail "tracked source text" "filter: $(head -1 "$TMP/err")"
else
  report "tracked source text" text-hits
fi

section "build: pnpm build output"
build_dirs=$(ls -d packages/*/dist packages/*/.wrangler/validate 2>/dev/null)
if [ -z "$build_dirs" ]; then
  fail "build output" "no packages/*/dist or .wrangler/validate: run pnpm build first"
else
  echo "checked: $(printf '%s\n' $build_dirs | wc -l | tr -d ' ') output directories"
  # Line by line, with the same provenance exclusion as the source check: a build copies comments.
  # shellcheck disable=SC2086
  grep -rnE "$CONTENT_PATTERN" $build_dirs > "$TMP/build-raw" 2> "$TMP/err"; st=$?
  if [ "$st" -ge 2 ]; then
    fail "build output" "grep exited $st: $(head -1 "$TMP/err")"
  elif ! node "$LIB" filter < "$TMP/build-raw" > "$TMP/build-hits" 2> "$TMP/err"; then
    fail "build output" "filter: $(head -1 "$TMP/err")"
  else
    report "build output lines" build-hits
  fi
fi

section "runtime: every worker config, generated ones included"
node "$LIB" configs . > "$TMP/configs" 2> "$TMP/err"; st=$?
if [ "$st" -ge 2 ]; then
  fail "runtime" "fence-lib.mjs configs exited $st: $(head -1 "$TMP/err")"
else
  grep -E '^#' "$TMP/configs"
  grep -E '^HIT ' "$TMP/configs" > "$TMP/runtime-hits"
  # The scanner's own verdict and the printed hits must agree, or the scan is not trusted.
  if { [ "$st" -eq 1 ] && [ ! -s "$TMP/runtime-hits" ]; } || { [ "$st" -eq 0 ] && [ -s "$TMP/runtime-hits" ]; }; then
    fail "runtime" "exit $st disagrees with the hits printed"
  else
    report "runtime names" runtime-hits
  fi
fi

finish
