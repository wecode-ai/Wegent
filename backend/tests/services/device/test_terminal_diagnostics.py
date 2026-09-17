# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for opt-in terminal backend diagnostics."""

import asyncio
from unittest.mock import Mock

import pytest

from app.core.config import settings
from app.services.device import terminal_diagnostics


@pytest.fixture
def targeted_device(monkeypatch):
    monkeypatch.setattr(
        settings, "TERMINAL_BACKEND_DIAGNOSTICS_DEVICE_IDS", "device-1, device-2"
    )
    monkeypatch.setattr(settings, "TERMINAL_BACKEND_DIAGNOSTICS_SAMPLE_RATE", 0.0)
    monkeypatch.setattr(
        settings, "TERMINAL_BACKEND_DIAGNOSTICS_SLOW_THRESHOLD_MS", 50.0
    )


def test_device_filter_is_exact_and_does_not_support_wildcard(monkeypatch):
    monkeypatch.setattr(
        settings,
        "TERMINAL_BACKEND_DIAGNOSTICS_DEVICE_IDS",
        "device-1,*,device-2",
    )

    assert terminal_diagnostics.is_target_device("device-1") is True
    assert terminal_diagnostics.is_target_device("device-10") is False
    assert terminal_diagnostics.is_target_device("*") is False


def test_control_event_is_sampled_and_session_is_hashed(targeted_device):
    trace = terminal_diagnostics.create_terminal_trace(
        device_id="device-1",
        session_id="terminal-secret-session",
        event="terminal:input",
        direction="browser_to_device",
        byte_count=9,
    )

    assert trace is not None
    assert trace.sampled is True
    assert trace.sample_reason == "input"
    assert trace.session_hash != "terminal-secret-session"
    assert len(trace.session_hash) == 12
    assert "terminal-secret-session" not in str(trace.metadata())


def test_unsampled_output_still_has_propagation_metadata(targeted_device):
    trace = terminal_diagnostics.create_terminal_trace(
        device_id="device-1",
        session_id="terminal-1",
        event="terminal:output",
        direction="device_to_browser",
    )

    assert trace is not None
    assert trace.sampled is False
    assert trace.sample_reason == "not_sampled"
    assert terminal_diagnostics.TerminalTrace.from_metadata(trace.metadata()) == trace


def test_unsampled_output_does_not_encode_payload(targeted_device):
    class EncodingMustNotRun(str):
        def encode(self, *_args, **_kwargs):
            raise AssertionError("unsampled output must not be encoded")

    trace = terminal_diagnostics.create_terminal_trace(
        device_id="device-1",
        session_id="terminal-1",
        event="terminal:output",
        direction="device_to_browser",
    )

    assert trace is not None
    assert trace.sampled is False
    assert (
        terminal_diagnostics.with_terminal_trace_bytes(
            trace, EncodingMustNotRun("secret output")
        )
        is trace
    )


def test_unsampled_fast_stage_is_quiet_but_slow_stage_is_logged(
    targeted_device, monkeypatch
):
    trace = terminal_diagnostics.create_terminal_trace(
        device_id="device-1",
        session_id="terminal-1",
        event="terminal:output",
        direction="device_to_browser",
    )
    log = Mock()
    monkeypatch.setattr(terminal_diagnostics.logger, "info", log)

    terminal_diagnostics.record_terminal_trace(
        trace, stage="namespace.relay", result="success", relay_ms=1.0
    )
    log.assert_not_called()

    terminal_diagnostics.record_terminal_trace(
        trace,
        stage="namespace.relay",
        result="success",
        relay_ms=51.0,
        reason_code="safe_reason",
        data="secret-output",
        sid="secret-sid",
        token="secret-token",
    )

    logged_fields = log.call_args.args[2]
    assert "sample_reason=slow" in logged_fields
    assert "relay_ms=51.0" in logged_fields
    assert "terminal-1" not in logged_fields
    assert "secret-output" not in logged_fields
    assert "secret-sid" not in logged_fields
    assert "secret-token" not in logged_fields


def test_logging_failure_never_escapes(targeted_device, monkeypatch):
    trace = terminal_diagnostics.create_terminal_trace(
        device_id="device-1",
        session_id="terminal-1",
        event="terminal:input",
        direction="browser_to_device",
    )
    monkeypatch.setattr(
        terminal_diagnostics.logger, "info", Mock(side_effect=RuntimeError("boom"))
    )
    monkeypatch.setattr(
        terminal_diagnostics.logger, "debug", Mock(side_effect=RuntimeError("boom"))
    )

    terminal_diagnostics.record_terminal_trace(
        trace, stage="namespace.relay", result="success", relay_ms=1.0
    )


@pytest.mark.asyncio
async def test_event_loop_sampler_is_owned_and_stopped(targeted_device, monkeypatch):
    monkeypatch.setattr(
        settings, "TERMINAL_BACKEND_DIAGNOSTICS_LOOP_LAG_INTERVAL_SECONDS", 0.1
    )

    task = terminal_diagnostics.start_event_loop_lag_sampler()

    assert isinstance(task, asyncio.Task)
    assert task.get_name() == "terminal-event-loop-lag"
    await terminal_diagnostics.stop_event_loop_lag_sampler()
    assert task.cancelled()


@pytest.mark.asyncio
async def test_event_loop_sampler_stays_off_without_targets(monkeypatch):
    monkeypatch.setattr(settings, "TERMINAL_BACKEND_DIAGNOSTICS_DEVICE_IDS", "")

    assert terminal_diagnostics.start_event_loop_lag_sampler() is None
    await terminal_diagnostics.stop_event_loop_lag_sampler()
