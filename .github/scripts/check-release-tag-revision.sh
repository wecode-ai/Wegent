#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

tag="$1"
ref="refs/tags/$tag"
if git show-ref --verify --quiet "$ref"; then
  target="$(git rev-parse --verify "${ref}^{commit}")"
  revision="$(git rev-parse HEAD)"
  if [ "$target" != "$revision" ]; then
    printf 'Release tag %s points to %s, but the release checkout is %s\n' "$tag" "$target" "$revision" >&2
    exit 1
  fi
fi
