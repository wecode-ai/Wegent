# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from executor_manager.routers import wegent_e2b_proxy


@pytest.mark.asyncio
async def test_proxy_retries_when_the_selected_sandbox_cannot_be_confirmed(mocker):
    """A stale proxy request cannot reach an already-replaced sandbox."""
    refresh = AsyncMock(return_value=False)
    manager = SimpleNamespace(refresh_sandbox_activity=refresh)
    sandbox = SimpleNamespace(sandbox_id="1385")
    request = SimpleNamespace(method="POST", body=AsyncMock(return_value=b""))

    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)
    mocker.patch.object(
        wegent_e2b_proxy, "_get_sandbox_info", return_value=("http://sandbox", sandbox)
    )

    with pytest.raises(HTTPException) as error:
        await wegent_e2b_proxy.proxy_to_sandbox("1385", 49983, "execute", request)

    assert error.value.status_code == 503
    refresh.assert_awaited_once_with(sandbox)
