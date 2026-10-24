#!/usr/bin/env bash
set -euo pipefail

# Ubuntu also restricts UID-map setup for unprivileged user namespaces; the
# disposable runner grants SYS_ADMIN so Codex can establish its own sandbox.
id
sed -n '/^Uid:/p; /^Gid:/p; /^CapEff:/p; /^CapBnd:/p; /^NoNewPrivs:/p' /proc/self/status
cat /proc/self/uid_map /proc/self/gid_map /proc/self/attr/current
for setting in /proc/sys/kernel/unprivileged_userns_clone /proc/sys/kernel/apparmor_restrict_unprivileged_userns; do
  if [[ -r "$setting" ]]; then
    printf '%s=' "$setting"
    cat "$setting"
  fi
done

# Exercise the namespace and proc-mount primitives required by native Codex.
# Never disable the product sandbox when the outer runner cannot host it.
unshare --user --map-root-user --mount --pid --fork --mount-proc /bin/true
