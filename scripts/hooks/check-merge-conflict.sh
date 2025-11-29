#!/bin/bash
# Check for merge conflict markers in files
# Usage: check-merge-conflict.sh [files...]

if [ $# -eq 0 ]; then
    exit 0
fi

found_conflict=0
for file in "$@"; do
    if [ -f "$file" ] && grep -q "^<<<<<<< " "$file" 2>/dev/null; then
        echo "Merge conflict markers found in: $file"
        found_conflict=1
    fi
done

if [ $found_conflict -eq 1 ]; then
    echo ""
    echo "Please resolve merge conflicts before pushing."
    exit 1
fi

exit 0
