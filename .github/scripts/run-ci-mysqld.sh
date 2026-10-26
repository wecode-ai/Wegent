#!/usr/bin/env bash
set -euo pipefail

# An unconfined CI container otherwise attaches the host's /usr/sbin/mysqld
# profile, which permits /var/lib/mysql but rejects isolated per-test data dirs.
exec aa-exec --profile=unconfined -- /usr/sbin/mysqld "$@"
