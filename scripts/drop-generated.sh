#!/usr/bin/env bash
# Reads paths (one per line) on stdin, prints those without the "Code generated … DO NOT EDIT."
# header (Go's convention; tygo writes it too): the size and comment checks skip generated files.
set -euo pipefail
files=$(cat)
[ -n "$files" ] || exit 0
# shellcheck disable=SC2086 # one path per line, none with spaces
# exit 1 = "nothing listed" or, before GNU grep 3.5, "something listed"; 2 = an error
grep -LE '^// Code generated .* DO NOT EDIT\.$' $files || [ $? = 1 ]
