# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared subpackages reused across all Wegent services.

Keeps the namespace flat and importable from any module
(``from shared.common.distributed_lock import DistributedLock``).
"""

from shared.common.distributed_lock import DistributedLock, get_distributed_lock

__all__ = ["DistributedLock", "get_distributed_lock"]
