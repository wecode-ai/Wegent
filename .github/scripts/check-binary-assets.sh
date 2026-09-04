#!/usr/bin/env bash
# Identify added or modified images and binary files in a pull request.

set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <changed-files-json> <target-root> <report-file>" >&2
    exit 2
fi

CHANGED_FILES_JSON="$1"
TARGET_ROOT="$2"
REPORT_FILE="$3"
PATH_LIST="$(mktemp)"

cleanup() {
    rm -f "$PATH_LIST"
}
trap cleanup EXIT

if [ ! -f "$CHANGED_FILES_JSON" ]; then
    echo "Changed-files JSON does not exist: $CHANGED_FILES_JSON" >&2
    exit 2
fi

if [ ! -d "$TARGET_ROOT" ]; then
    echo "Pull request target tree does not exist: $TARGET_ROOT" >&2
    exit 2
fi

if ! command -v file >/dev/null 2>&1; then
    echo "file is required to classify changed files." >&2
    exit 2
fi

classify_path() {
    local relative_path="$1"
    local target_path="$TARGET_ROOT/$relative_path"
    local mime_type
    local mime_encoding
    local lowercase_path

    if [ ! -f "$target_path" ]; then
        return
    fi

    mime_type="$(file --brief --mime-type "$target_path")"
    mime_encoding="$(file --brief --mime-encoding "$target_path")"
    lowercase_path="$(printf '%s' "$relative_path" | tr '[:upper:]' '[:lower:]')"

    if [[ "$mime_type" == image/* ]] ||
        [[ "$lowercase_path" =~ \.(avif|bmp|gif|heic|heif|icns|ico|jpeg|jpg|jxl|png|psd|svg|svgz|tif|tiff|webp)$ ]]; then
        printf '%s\timage\t%s\n' "$relative_path" "$mime_type" >> "$REPORT_FILE"
    elif [ ! -s "$target_path" ]; then
        return
    elif [ "$mime_encoding" = "binary" ]; then
        printf '%s\tbinary\t%s\n' "$relative_path" "$mime_type" >> "$REPORT_FILE"
    fi
}

: > "$REPORT_FILE"

# The JavaScript program is intentionally literal.
# shellcheck disable=SC2016
node -e '
const fs = require("fs")
const paths = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
if (!Array.isArray(paths)) {
  throw new Error("Changed-files JSON must contain an array")
}
for (const path of paths) {
  if (typeof path !== "string" || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Unsafe changed path: ${String(path)}`)
  }
  process.stdout.write(`${path}\0`)
}
' "$CHANGED_FILES_JSON" > "$PATH_LIST"

while IFS= read -r -d '' relative_path; do
    classify_path "$relative_path"
done < "$PATH_LIST"

if [ -s "$REPORT_FILE" ]; then
    echo "requires_approval=true"
    echo "Changed images or binary files require approval from a repository administrator:"
    awk -F '\t' '{ printf "  - %s (%s, %s)\n", $1, $2, $3 }' "$REPORT_FILE"
else
    echo "requires_approval=false"
    echo "No added or modified images or binary files found."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
    if [ -s "$REPORT_FILE" ]; then
        echo "requires_approval=true" >> "$GITHUB_OUTPUT"
    else
        echo "requires_approval=false" >> "$GITHUB_OUTPUT"
    fi
fi
