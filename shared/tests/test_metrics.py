# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for the wecode metrics tool."""

import json
import time

import pytest

from shared.metrics.api import ApiRouteMetrics, track_api, track_api_sync
from shared.metrics.metric import Metric, MetricType, Slot, _drain
from shared.metrics.profile import (
    _HourlyRotatingWriter,
    profile_interval_seconds,
    profile_log_path,
    render_entry,
    reset_profile_log_path,
    write_profile_once,
)
from shared.metrics.registry import get_registry


@pytest.fixture(autouse=True)
def disable_profile_logger(monkeypatch):
    monkeypatch.setenv("WECODE_METRICS_ENABLED", "false")
    monkeypatch.delenv("WEGENT_LOG_FILE_PATH", raising=False)
    monkeypatch.setattr("shared.metrics.registry._logger_thread", None, raising=False)
    reset_profile_log_path()
    yield
    reset_profile_log_path()


def make_metric(name: str, metric_type: MetricType) -> Metric:
    return Metric(name, metric_type, Slot())


class TestRecord:
    def test_buckets_and_slow(self):
        metric = make_metric("svc", MetricType.API)
        metric.record(0.005)  # 5ms -> interval1
        metric.record(0.02)  # 20ms -> interval2
        metric.record(
            0.08
        )  # 80ms -> interval3, slow for RESOURCE but not SERVICE policy
        metric.record(0.15)  # 150ms -> interval4
        metric.record(0.5, success=False)  # 500ms -> interval5, slow, failure
        snapshot = metric.snapshot()
        assert snapshot.total == 5
        assert snapshot.intervals == (1, 1, 1, 1, 1)
        assert snapshot.failure == 1
        assert snapshot.success == 4
        # API policy: slow threshold 200ms -> only the 500ms call is slow.
        assert snapshot.slow == 1

    def test_custom_slow_threshold(self):
        """A per-record slow threshold overrides the policy."""
        metric = make_metric("svc-slow", MetricType.API)
        metric.record(0.4)  # 400ms, slow under 200ms policy
        metric.record(0.4, slow_threshold_ms=500)  # 400ms, not slow at 500ms
        snapshot = metric.snapshot()
        assert snapshot.total == 2
        assert snapshot.slow == 1

    def test_resource_policy_slow_threshold(self):
        metric = make_metric("op", MetricType.LOG)
        metric.record(0.06)  # 60ms >= 50ms resource slow threshold
        assert metric.snapshot().slow == 1

    def test_increment_counts_into_interval1(self):
        metric = make_metric("counter", MetricType.LOG)
        metric.increment()
        metric.increment(4)
        snapshot = metric.snapshot()
        assert snapshot.total == 5
        assert snapshot.intervals == (5, 0, 0, 0, 0)
        assert snapshot.elapsed_ns == 0

    def test_rejects_invalid_values(self):
        metric = make_metric("svc2", MetricType.SERVICE)
        with pytest.raises(ValueError):
            metric.record(-1)
        with pytest.raises(TypeError):
            metric.record("10ms")  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            metric.increment(1.5)  # type: ignore[arg-type]

    def test_drain_resets_window(self):
        metric = make_metric("svc3", MetricType.API)
        metric.record(0.01)
        first = _drain(metric._slot)
        assert first.total == 1
        second = _drain(metric._slot)
        assert second.total == 0


class TestRegistry:
    def test_same_slot_for_same_name_and_type(self):
        registry = get_registry()
        one = registry.register("shared.metric", MetricType.LOG)
        two = registry.register("shared.metric", MetricType.LOG)
        one.increment()
        assert two.snapshot().total == 1

    def test_same_name_different_type_is_distinct(self):
        registry = get_registry()
        log_metric = registry.register("typed.metric", MetricType.LOG)
        api_metric = registry.register("typed.metric", MetricType.API)
        log_metric.increment()
        assert api_metric.snapshot().total == 0


class TestApiRouteMetrics:
    def test_records_status_classes(self):
        route = ApiRouteMetrics("/api/v1/responses")
        route.record(200, 0.01)
        route.record(201, 0.02)
        route.record(404, 0.03)
        route.record(500, 0.3)
        ok = get_registry().register("/api/v1/responses_2xx", MetricType.API).snapshot()
        not_found = (
            get_registry().register("/api/v1/responses_4xx", MetricType.API).snapshot()
        )
        failed = (
            get_registry().register("/api/v1/responses_5xx", MetricType.API).snapshot()
        )
        assert (ok.total, ok.failure) == (2, 0)
        assert (not_found.total, not_found.failure) == (1, 1)
        assert (failed.total, failed.failure, failed.slow) == (1, 1, 1)

    def test_ignores_non_api_classes(self):
        route = ApiRouteMetrics("/api/v1/test-ignore")
        route.record(100, 0.01)
        route.record(600, 0.01)
        for status_class in ("2xx", "3xx", "4xx", "5xx"):
            snapshot = (
                get_registry()
                .register(f"/api/v1/test-ignore_{status_class}", MetricType.API)
                .snapshot()
            )
            assert snapshot.total == 0


class _FakeResponse:
    """Minimal stand-in for a web framework response object."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _FakeError(Exception):
    """Minimal stand-in for a web framework HTTP error."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"http {status_code}")
        self.status_code = status_code


def _class_total(metric_name: str) -> int:
    return get_registry().register(metric_name, MetricType.API).snapshot().total


class TestTrackApi:
    @pytest.mark.asyncio
    async def test_records_returned_status(self):
        metrics = ApiRouteMetrics("/test/tracked")

        @track_api(metrics)
        async def handler():
            return _FakeResponse(201)

        before = _class_total("/test/tracked_2xx")
        await handler()
        assert _class_total("/test/tracked_2xx") == before + 1

    @pytest.mark.asyncio
    async def test_records_raised_status_and_keeps_raising(self):
        metrics = ApiRouteMetrics("/test/tracked-error")

        @track_api(metrics)
        async def handler():
            raise _FakeError(404)

        before = _class_total("/test/tracked-error_4xx")
        with pytest.raises(_FakeError):
            await handler()
        assert _class_total("/test/tracked-error_4xx") == before + 1

    @pytest.mark.asyncio
    async def test_defaults_to_200_without_a_status_attribute(self):
        metrics = ApiRouteMetrics("/test/tracked-plain")

        @track_api(metrics)
        async def handler():
            return {"ok": True}

        before = _class_total("/test/tracked-plain_2xx")
        await handler()
        assert _class_total("/test/tracked-plain_2xx") == before + 1

    def test_rejects_sync_handlers(self):
        metrics = ApiRouteMetrics("/test/tracked-sync")
        with pytest.raises(TypeError):

            @track_api(metrics)
            def handler():
                return None


class TestTrackApiSync:
    def test_records_returned_status(self):
        metrics = ApiRouteMetrics("/test/tracked-sync")

        @track_api_sync(metrics)
        def handler():
            return _FakeResponse(201)

        before = _class_total("/test/tracked-sync_2xx")
        handler()
        assert _class_total("/test/tracked-sync_2xx") == before + 1

    def test_records_raised_status_and_keeps_raising(self):
        metrics = ApiRouteMetrics("/test/tracked-sync-error")

        @track_api_sync(metrics)
        def handler():
            raise _FakeError(404)

        before = _class_total("/test/tracked-sync-error_4xx")
        with pytest.raises(_FakeError):
            handler()
        assert _class_total("/test/tracked-sync-error_4xx") == before + 1

    def test_rejects_async_handlers(self):
        metrics = ApiRouteMetrics("/test/tracked-sync-async")
        with pytest.raises(TypeError):

            @track_api_sync(metrics)
            async def handler():
                return None


class TestProfileLog:
    def test_render_entry_matches_profile_util_format(self):
        metric = make_metric("wecode.test", MetricType.API)
        metric.record(0.01)
        metric.record(0.5, success=False)
        line = render_entry(
            "2026-09-20 15:00:00", "API", metric.name, 200, _drain(metric._slot)
        )
        timestamp, payload = line.rstrip("\n").split(" ", 1)
        # Timestamp carries a space; split off the date part too.
        date, clock, payload = line.rstrip("\n").split(" ", 2)
        entry = json.loads(payload)
        assert f"{date} {clock}" == "2026-09-20 15:00:00"
        assert entry == {
            "type": "API",
            "name": "wecode.test",
            "slowThreshold": 200,
            "total_count": 2,
            "error_count": 1,
            "slow_count": 1,
            "avg_time": "255.00",
            # 10ms is not < 10ms, so it lands in the second bucket.
            "interval1": 0,
            "interval2": 1,
            "interval3": 0,
            "interval4": 0,
            "interval5": 1,
        }
        assert timestamp == "2026-09-20"

    def test_write_profile_once_drains_and_writes_baseline(self, tmp_path):
        profile_log = tmp_path / "nested" / "profile.log"
        metric = get_registry().register("wecode.write_once", MetricType.LOG)
        metric.increment(3)
        write_profile_once(profile_log)
        lines = profile_log.read_text().splitlines()
        assert len(lines) >= 2
        entries = [json.loads(line.split(" ", 2)[2]) for line in lines]
        by_name = {entry["name"]: entry for entry in entries}
        assert by_name["wecode.write_once"]["total_count"] == 3
        assert by_name["other://profile_baseline"]["type"] == "OTHER"
        # The slot was drained by the write.
        assert metric.snapshot().total == 0

    def test_default_slow_threshold_is_policy_default(self, tmp_path):
        """LOG metrics without an explicit threshold must render a number."""
        profile_log = tmp_path / "profile.log"
        metric = get_registry().register("wecode.default_threshold", MetricType.LOG)
        metric.increment(1)
        write_profile_once(profile_log)
        entries = [
            json.loads(line.split(" ", 2)[2])
            for line in profile_log.read_text().splitlines()
        ]
        entry = next(
            item for item in entries if item["name"] == "wecode.default_threshold"
        )
        assert entry["slowThreshold"] == 50

    def test_empty_window_renders_bare_zero_average(self):
        metric = make_metric("wecode.empty", MetricType.API)
        line = render_entry(
            "2026-09-20 15:00:00", "API", metric.name, 200, _drain(metric._slot)
        )
        entry = json.loads(line.split(" ", 2)[2])
        # The Java/brz-metrics writer emits a number, not a string, with no data.
        assert entry["avg_time"] == 0.0
        assert entry["total_count"] == 0


def _epoch(text: str) -> float:
    return time.mktime(time.strptime(text, "%Y-%m-%d %H:%M:%S"))


class TestHourlyRotation:
    def test_rolls_over_on_hour_boundary(self, tmp_path):
        writer = _HourlyRotatingWriter(tmp_path / "profile.log")
        writer.append("h14\n", now=_epoch("2026-09-22 14:30:00"))
        writer.append("h15\n", now=_epoch("2026-09-22 15:30:00"))
        assert (tmp_path / "profile.log").read_text() == "h15\n"
        assert (tmp_path / "profile.log.20260922-14").read_text() == "h14\n"

    def test_same_hour_appends_without_rotation(self, tmp_path):
        writer = _HourlyRotatingWriter(tmp_path / "profile.log")
        writer.append("a\n", now=_epoch("2026-09-22 14:10:00"))
        writer.append("b\n", now=_epoch("2026-09-22 14:50:00"))
        assert (tmp_path / "profile.log").read_text() == "a\nb\n"
        assert not (tmp_path / "profile.log.20260922-14").exists()

    def test_does_not_overwrite_existing_rotated_file(self, tmp_path):
        """Another process may win the rollover race; its rotated file is kept."""
        writer = _HourlyRotatingWriter(tmp_path / "profile.log")
        writer.append("h14\n", now=_epoch("2026-09-22 14:30:00"))
        (tmp_path / "profile.log").write_text("newer content from other process\n")
        (tmp_path / "profile.log.20260922-14").write_text("already rotated\n")
        writer.append("h15\n", now=_epoch("2026-09-22 15:30:00"))
        assert (tmp_path / "profile.log.20260922-14").read_text() == "already rotated\n"
        assert (
            tmp_path / "profile.log"
        ).read_text() == "newer content from other process\nh15\n"


class TestConfig:
    def test_profile_log_path_env_priority(self, monkeypatch, tmp_path):
        monkeypatch.setenv("WECODE_METRICS_PROFILE_LOG_PATH", str(tmp_path / "a.log"))
        assert profile_log_path() == tmp_path / "a.log"
        monkeypatch.delenv("WECODE_METRICS_PROFILE_LOG_PATH")
        reset_profile_log_path()
        monkeypatch.setenv("WEGENT_LOG_FILE_PATH", str(tmp_path / "logs" / "info.log"))
        assert profile_log_path() == tmp_path / "logs" / "profile.log"
        monkeypatch.delenv("WEGENT_LOG_FILE_PATH")
        reset_profile_log_path()
        monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
        assert profile_log_path() == tmp_path / "logs" / "profile.log"
        monkeypatch.delenv("LOG_DIR")
        reset_profile_log_path()
        assert profile_log_path().as_posix() == "logs/profile.log"

    def test_profile_log_follows_info_log_path(self, monkeypatch, tmp_path):
        """The profile log derives from the executor_manager info log path."""
        monkeypatch.setenv(
            "WEGENT_LOG_FILE_PATH", str(tmp_path / "nested" / "info.log")
        )
        assert profile_log_path() == tmp_path / "nested" / "profile.log"

    def test_rust_profile_path_does_not_capture_python_log(self, monkeypatch, tmp_path):
        """The Rust gateway's profile log stays untouched by Python metrics."""
        monkeypatch.delenv("WECODE_METRICS_PROFILE_LOG_PATH", raising=False)
        monkeypatch.setenv("BREEZE_PROFILE_LOG_PATH", str(tmp_path / "rust.log"))
        monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
        assert profile_log_path() == tmp_path / "logs" / "profile.log"

    def test_interval_defaults_and_validation(self, monkeypatch):
        monkeypatch.delenv("WECODE_METRICS_PROFILE_INTERVAL_SECONDS", raising=False)
        assert profile_interval_seconds() == 30
        monkeypatch.setenv("WECODE_METRICS_PROFILE_INTERVAL_SECONDS", "30")
        assert profile_interval_seconds() == 30
        monkeypatch.setenv("WECODE_METRICS_PROFILE_INTERVAL_SECONDS", "not-a-number")
        assert profile_interval_seconds() == 30

    def test_profile_log_path_is_read_once(self, monkeypatch, tmp_path):
        """A deployment path change after startup must not switch log files."""
        monkeypatch.setenv(
            "WECODE_METRICS_PROFILE_LOG_PATH", str(tmp_path / "first.log")
        )
        assert profile_log_path() == tmp_path / "first.log"
        monkeypatch.setenv(
            "WECODE_METRICS_PROFILE_LOG_PATH", str(tmp_path / "second.log")
        )
        assert profile_log_path() == tmp_path / "first.log"
