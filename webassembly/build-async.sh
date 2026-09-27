#!/usr/bin/env bash
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$root/webassembly/build.log"
exit_file="$root/webassembly/build.exit"
# This wrapper is for Codespace; CI invokes build.sh directly.
rm -f "$exit_file"
bash "$root/webassembly/build.sh" > "$log" 2>&1
result=$?
printf '%s\n' "$result" > "$exit_file"
exit "$result"
