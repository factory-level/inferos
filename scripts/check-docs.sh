#!/usr/bin/env bash
# Validate documentation structure for the Documentation Loop.
# Errors exit non-zero; warnings are reported but do not fail.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2

errors=0
warnings=0

error() { printf 'ERROR: %s\n' "$*"; errors=$((errors + 1)); }
warn() { printf 'WARN:  %s\n' "$*"; warnings=$((warnings + 1)); }

# Print the YAML front matter of a file, without the delimiters.
front_matter() {
  awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit } NR > 1 { print }' "$1"
}

# Print a scalar, including the quoted dates emitted by the migration helper.
fm_value() {
  front_matter "$1" | sed -n "s/^$2:[[:space:]]*//p" | head -n 1 | sed -e "s/^'\(.*\)'$/\1/" -e 's/^"\(.*\)"$/\1/'
}

# Accept indented lists and PyYAML's indentless block lists.
fm_list() {
  front_matter "$1" | awk -v key="$2" '
    $0 ~ "^" key ":" { in_list = 1; next }
    in_list && /^[[:space:]]*-[[:space:]]/ { sub(/^[[:space:]]*-[[:space:]]+/, ""); print; next }
    in_list && /^[^[:space:]]/ { in_list = 0 }
  '
}

is_template() {
  case "$(basename "$1")" in
    _template.md | 0000-template.md | README.md) return 0 ;;
  esac
  return 1
}

check_keys() {
  local file="$1"; shift
  if [ "$(head -n 1 "$file")" != "---" ]; then
    error "$file: missing YAML front matter"
    return
  fi
  local key
  for key in "$@"; do
    if ! front_matter "$file" | grep -q "^$key:"; then
      error "$file: missing front matter key '$key'"
    fi
  done
}

check_enum() {
  local file="$1" key="$2" value; shift 2
  value="$(fm_value "$file" "$key")"
  [ -z "$value" ] && return
  local allowed
  for allowed in "$@"; do
    [ "$value" = "$allowed" ] && return
  done
  error "$file: $key '$value' is not one of: $*"
}

check_date() {
  local file="$1" key="$2" value
  value="$(fm_value "$file" "$key")"
  [ -z "$value" ] && return
  if ! [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    error "$file: $key '$value' is not a YYYY-MM-DD date"
  fi
}

check_indexed() {
  local file="$1" index
  index="$(dirname "$file")/README.md"
  if [ ! -f "$index" ]; then
    error "$index: missing folder index"
  elif ! grep -qF "]($(basename "$file"))" "$index"; then
    warn "$file: not listed in $index"
  fi
}

shopt -s nullglob

for file in docs/*/*.md; do
  is_template "$file" && continue
  [ "$file" = docs/architecture/_brain.md ] && continue
  if ! [[ "$(basename "$file")" =~ ^[a-z0-9][a-z0-9-]*\.md$ ]]; then
    error "$file: filename must be lowercase and hyphen-separated"
  fi
done

# Keep one design authority: the retired local folder contains only its README.
while IFS= read -r file; do
  [ "$file" = docs/design/README.md ] || error "$file: design belongs in Obsidian; follow docs/architecture/_brain.md"
done < <(find docs/design -type f | sort)

for file in docs/architecture/*.md; do
  is_template "$file" && continue
  check_keys "$file" title covers updated
  check_date "$file" updated
  check_indexed "$file"
  covered=0
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    covered=1
    if [ ! -e "$path" ]; then
      error "$file: covered path '$path' does not exist"
    fi
  done < <(fm_list "$file" covers)
  [ "$covered" -eq 0 ] && error "$file: 'covers' lists no paths"
done

for file in docs/adr/*.md; do
  is_template "$file" && continue
  if ! [[ "$(basename "$file")" =~ ^[0-9]{4}-[a-z0-9-]+\.md$ ]]; then
    error "$file: ADR filename must match NNNN-short-slug.md"
  fi
  check_keys "$file" title status date
  check_enum "$file" status proposed accepted superseded deprecated
  check_date "$file" date
  check_indexed "$file"
done
duplicates="$(for file in docs/adr/[0-9][0-9][0-9][0-9]-*.md; do basename "$file" | cut -c1-4; done | grep -v '^0000$' | sort | uniq -d)"
for number in $duplicates; do
  error "docs/adr: ADR number $number is used more than once"
done

for file in docs/wiki/*.md; do
  is_template "$file" && continue
  check_keys "$file" title updated
  check_date "$file" updated
  check_indexed "$file"
done

# Relative links in all Markdown files outside templates must resolve.
while IFS= read -r file; do
  case "$(basename "$file")" in
    _template.md | 0000-template.md) continue ;;
  esac
  dir="$(dirname "$file")"
  while IFS= read -r target; do
    target="${target%%#*}"
    [ -z "$target" ] && continue
    case "$target" in
      http://* | https://* | mailto:* | obsidian://*) continue ;;
    esac
    if [ ! -e "$dir/$target" ]; then
      error "$file: broken link '$target'"
    fi
  done < <(grep -o '\]([^)[:space:]]*)' "$file" | sed 's/^](//; s/)$//')
done < <(find docs -name '*.md' -type f | sort)

# Architecture records its Obsidian designs; CI validates structure without vault access.
node scripts/check-obsidian-designs.ts docs/architecture/*.md || error "Obsidian design reference validation failed"

printf '%d error(s), %d warning(s)\n' "$errors" "$warnings"
[ "$errors" -eq 0 ]
