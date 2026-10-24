#!/usr/bin/env bash
set -euo pipefail

# Exercise the namespace and proc-mount primitives required by native Codex.
# Never disable the product sandbox when the outer runner cannot host it.
unshare --user --map-root-user --mount --pid --fork --mount-proc /bin/true
