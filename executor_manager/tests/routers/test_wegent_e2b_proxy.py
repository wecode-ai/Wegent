# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

from executor_manager.routers import wegent_e2b_proxy


def test_touch_sandbox_activity_persists_proxy_activity(mocker):
    """Proxied E2B SDK calls should refresh sandbox activity for GC."""
    repository = MagicMock()
    manager = SimpleNamespace(_repository=repository)
    sandbox = MagicMock()
    sandbox.sandbox_id = "1385"

    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)

    wegent_e2b_proxy._touch_sandbox_activity(sandbox)

    sandbox.touch.assert_called_once_with()
    repository.save_sandbox.assert_called_once_with(sandbox)
