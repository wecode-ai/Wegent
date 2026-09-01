# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -eu

rm -rf gvm
git clone --depth 1 \
  ssh://git@git.intra.weibo.com:2222/noc-monitor/mirror/gvm.git \
  gvm
mv gvm/.git gvm/git.bak
printf '%s\n' \
  'export GVM_ROOT=/root/.gvm' \
  '. $GVM_ROOT/scripts/gvm-default' \
  > gvm/scripts/gvm
