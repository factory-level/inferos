#!/usr/bin/env bash
# G0 fence audit (FAC-215): the clean InferOS baseline carries none of the archived fork's legacy
# operational frameworks: Consoles, Dots, widget/workspace kinds, Operate or canvas state. It checks
# three levels and prints every hit; it exits 1 on any hit and 0 when the tree is clean.
#
#   import:  tracked file paths and tracked source text (git ls-files / git grep)
#   build:   what `pnpm build` produced (packages/*/dist, packages/*/.wrangler/validate)
#   runtime: every wrangler*.json[c] under the tree, tracked or not: the committed configs and the
#            untracked wrangler.dev.jsonc files a dev-server run writes (root, workshop-backend,
#            each gatekeeper). Parsed, not grepped: bindings, classes, migrations, services, vars
#
# The identifiers are the fork's own names (inferOS archive/main-2026-11-14), not plain words:
# "console" and "canvas" alone are everywhere in upstream code (console.log, the HTML canvas).
# Run from the repository root:  bash scripts/inferlab-g0/fence-audit.sh
# FENCE_ROOT=<a git checkout> audits that tree instead, with this script's helpers (positive controls).
set -u
LIB="$(cd "$(dirname "$0")" && pwd)/fence-lib.mjs"
cd "${FENCE_ROOT:-$(git rev-parse --show-toplevel)}"

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

hits=0
section() { printf '\n## %s\n' "$1"; }
report() {
  # $1 = label, stdin = hit lines
  local out; out="$(cat)"
  if [ -n "$out" ]; then
    printf '%s\n' "$out"; printf -- '-> %s: %s hit(s)\n' "$1" "$(printf '%s\n' "$out" | wc -l | tr -d ' ')"
    hits=$((hits + 1))
  else
    printf -- '-> %s: none\n' "$1"
  fi
}

section "import: tracked paths"
report "tracked paths" < <(git ls-files | grep -E "$PATH_PATTERN")

section "import: tracked source text"
report "tracked source text" < <(git grep -nE "$CONTENT_PATTERN" -- . "$SELF" "$REPORT" "$LEDGER" | node "$LIB" filter)

section "build: pnpm build output"
build_dirs=$(ls -d packages/*/dist packages/*/.wrangler/validate 2>/dev/null)
if [ -z "$build_dirs" ]; then
  echo "-> build output: NOT CHECKED (no packages/*/dist or .wrangler/validate; run pnpm build first)"
  hits=$((hits + 1))
else
  echo "checked: $(printf '%s\n' $build_dirs | wc -l | tr -d ' ') output directories"
  # shellcheck disable=SC2086
  # Line by line, with the same provenance exclusion as the source check: a build copies comments.
  report "build output lines" < <(grep -rnE "$CONTENT_PATTERN" $build_dirs 2>/dev/null | node "$LIB" filter)
fi

section "runtime: every worker config, generated ones included"
config_scan="$(node "$LIB" configs .)"; config_status=$?
printf '%s\n' "$config_scan" | grep -E '^#'
report "runtime names" < <(printf '%s\n' "$config_scan" | grep -E '^HIT ')
[ "$config_status" -le 1 ] || { echo "-> runtime: scanner failed"; hits=$((hits + 1)); }

printf '\n%s\n' "$( [ "$hits" -eq 0 ] && echo 'RESULT: clean (0 levels with hits)' || echo "RESULT: $hits level(s) with hits")"
[ "$hits" -eq 0 ]
