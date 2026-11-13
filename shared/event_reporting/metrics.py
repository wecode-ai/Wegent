# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import logging
from typing import Any

from shared.telemetry.core import get_meter

logger = logging.getLogger(__name__)


class EventReportingMetrics:
    """Low-cardinality producer health metrics backed by OpenTelemetry."""

    def __init__(self, service_name: str) -> None:
        self._service_name = service_name
        self._instruments: dict[str, Any] = {}
        self._sender_state: str | None = None
        self._previous: dict[tuple[str, str], int] = {}
        try:
            meter = get_meter("wegent.event_reporting")
            for name in (
                "attempted",
                "enqueued",
                "acked",
                "dropped",
                "contract_error",
                "serialization_error",
                "delivery_failed",
                "delivery_unknown",
                "discarded",
            ):
                self._instruments[name] = meter.create_counter(
                    f"event_reporting_{name}_total"
                )
            self._instruments["queue_bytes"] = meter.create_gauge(
                "event_reporting_queue_bytes"
            )
            self._instruments["queue_events"] = meter.create_gauge(
                "event_reporting_queue_events"
            )
            self._instruments["sender_state"] = meter.create_gauge(
                "event_reporting_sender_state"
            )
            self._instruments["last_ack"] = meter.create_gauge(
                "event_reporting_last_ack_timestamp_seconds"
            )
        except Exception:
            self._instruments.clear()
            # Diagnostics must not recursively invoke an application log handler.
            pass

    def publish(self, health: dict[str, Any]) -> None:
        """Called only by the sender, never from business emit."""
        for event_type, counters in health.get("by_event_type", {}).items():
            for name, value in counters.items():
                key = (event_type, name)
                previous = self._previous.get(key, 0)
                self.count(
                    name.removesuffix("_total"), event_type, max(0, value - previous)
                )
                self._previous[key] = value
        self.set_queue(events=health["queue_events"], size_bytes=health["queue_bytes"])
        self.set_sender_state(health["sender_state"])
        if health.get("last_ack_timestamp_seconds") is not None:
            self.set_last_ack(health["last_ack_timestamp_seconds"])

    def count(
        self,
        name: str,
        event_type: str,
        count: int = 1,
        **attributes: str,
    ) -> None:
        instrument = self._instruments.get(name)
        if instrument is None or count <= 0:
            return
        labels = {
            "service": self._service_name,
            "event_type": event_type,
            **attributes,
        }
        self._safe_call(instrument.add, count, labels)

    def set_queue(self, *, events: int, size_bytes: int) -> None:
        labels = {"service": self._service_name}
        self._set_gauge("queue_events", events, labels)
        self._set_gauge("queue_bytes", size_bytes, labels)

    def set_sender_state(self, state: str) -> None:
        if self._sender_state == state:
            return
        if self._sender_state is not None:
            self._set_gauge(
                "sender_state",
                0,
                {"service": self._service_name, "state": self._sender_state},
            )
        self._set_gauge(
            "sender_state",
            1,
            {"service": self._service_name, "state": state},
        )
        self._sender_state = state

    def set_last_ack(self, timestamp_seconds: float) -> None:
        self._set_gauge(
            "last_ack",
            timestamp_seconds,
            {"service": self._service_name},
        )

    def _set_gauge(
        self,
        name: str,
        value: int | float,
        attributes: dict[str, str],
    ) -> None:
        instrument = self._instruments.get(name)
        if instrument is not None:
            self._safe_call(instrument.set, value, attributes)

    @staticmethod
    def _safe_call(call, *args) -> None:
        try:
            call(*args)
        except Exception:
            pass
