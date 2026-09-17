# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Backend ownership of the terminal diagnostic sampler."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app import main


def test_main_keeps_strong_reference_to_terminal_diagnostic_task(monkeypatch):
    task = object()
    app = SimpleNamespace(state=SimpleNamespace())
    start = Mock(return_value=task)
    monkeypatch.setattr(main, "start_event_loop_lag_sampler", start)

    main._start_terminal_diagnostics(app)

    start.assert_called_once_with()
    assert app.state.terminal_diagnostics_task is task


@pytest.mark.asyncio
async def test_main_awaits_terminal_diagnostic_shutdown(monkeypatch):
    stop = AsyncMock()
    monkeypatch.setattr(main, "stop_event_loop_lag_sampler", stop)

    await main._stop_terminal_diagnostics()

    stop.assert_awaited_once_with()
