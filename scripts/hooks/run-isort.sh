#!/bin/bash
# Run isort import sorting check on Python files
# Usage: run-isort.sh [files...]

if [ $# -eq 0 ]; then
    exit 0
fi

# Check if isort is available
if ! python -m isort --version >/dev/null 2>&1; then
    echo "isort not installed. Install with: pip install isort"
    exit 0
fi

# Run isort check
python -m isort --check-only --diff "$@" 2>/dev/null
exit_code=$?

if [ $exit_code -ne 0 ]; then
    echo ""
    echo "isort found import sorting issues. Run 'isort .' to fix."
fi

exit $exit_code
