# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KB stat service — gateway factory."""

from app.services.kb_stat.gateway import RemoteKbStatGateway

_gateway: RemoteKbStatGateway | None = None


def get_kb_stat_gateway() -> RemoteKbStatGateway:
    global _gateway
    if _gateway is None:
        _gateway = RemoteKbStatGateway()
    return _gateway
