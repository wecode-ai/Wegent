# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from wecode.service.mcp_providers.providers.weibo import WeiboMCPProvider


def test_internal_mcp_provider_opens_server_market() -> None:
    assert (
        WeiboMCPProvider().get_config().discover_url
        == "https://mcp.intra.weibo.com/servers"
    )
