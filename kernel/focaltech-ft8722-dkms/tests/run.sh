#!/bin/sh
set -eu
binary=$(mktemp)
trap 'rm -f "$binary"' EXIT HUP INT TERM

cc -std=c11 -Wall -Wextra -Werror \
  -I"$(dirname "$0")/include" \
  -I"$(dirname "$0")/.." \
  "$(dirname "$0")/ft8722_regressions.c" \
  "$(dirname "$0")/../ft8722_input.c" \
  -o "$binary"
"$binary"
