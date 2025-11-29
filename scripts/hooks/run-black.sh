#!/bin/bash
# Run Black formatter check on Python files
# Usage: run-black.sh [files...]

if [ $# -eq 0 ]; then
    exit 0
fi

# Check if black is available
if ! python -m black --version >/dev/null 2>&1; then
    echo "Black not installed. Install with: pip install black"
    exit 0
fi

# Run black check
python -m black --check --diff "$@" 2>/dev/null
exit_code=$?

if [ $exit_code -ne 0 ]; then
    echo ""
    echo "Black found formatting issues. Run 'black .' to fix."
fi

exit $exit_code
