# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read-only Git comparisons used by desktop and mobile cloud devices."""

import shlex

_BRANCH_BASE_SCRIPT = """
if [ "$#" -gt 1 ]; then
  echo "Expected at most one comparison branch" >&2; exit 64
fi
base=${1-}
merge_base=""
if [ "$#" -eq 1 ]; then
  case "$base" in ""|-*|@)
    echo "Invalid comparison branch" >&2; exit 64 ;;
  esac
  git check-ref-format --allow-onelevel "$base" >/dev/null || exit 64
  revision=$(git rev-parse --verify --end-of-options "$base^{commit}") || exit 65
  merge_base=$(git merge-base "$revision" HEAD) || exit 65
else
  for candidate in \
    "$(git symbolic-ref --quiet --short refs/remotes/upstream/HEAD 2>/dev/null)" \
    upstream/main upstream/master \
    "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" \
    origin/main origin/master main master; do
    [ -n "$candidate" ] || continue
    if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
      base="$candidate"; break
    fi
  done
  if [ -n "$base" ]; then
    merge_base=$(git merge-base "$base" HEAD 2>/dev/null || true)
  fi
fi
"""

_DIFF_SCRIPT = """
set -o pipefail
if [ -n "$merge_base" ]; then git diff --binary "$merge_base" -- || exit
elif git rev-parse --verify --quiet HEAD >/dev/null; then git diff --binary HEAD -- || exit
else git diff --binary -- || exit
fi
git ls-files --others --exclude-standard -z |
while IFS= read -r -d "" file; do
  git diff --binary --no-index -- /dev/null "$file"
  status=$?
  [ "$status" -le 1 ] || exit "$status"
done
"""

_SHORTSTAT_SCRIPT = """
if [ -n "$merge_base" ]; then git diff --shortstat "$merge_base" --
else git diff --shortstat HEAD --
fi
"""

# The explicit argv[0] keeps an optional comparison ref in $1 for bash -c.
GIT_BRANCH_DIFF_COMMAND = (
    "bash -c " + shlex.quote(_BRANCH_BASE_SCRIPT + _DIFF_SCRIPT) + " --"
)
GIT_BRANCH_DIFF_SHORTSTAT_COMMAND = (
    "bash -c " + shlex.quote(_BRANCH_BASE_SCRIPT + _SHORTSTAT_SCRIPT) + " --"
)
