# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.core.events import TaskCompletedEvent
from app.services.subscription.task_completion_handler import handle_task_completed
from app.tasks import subscription_tasks

pytestmark = pytest.mark.unit


class FakeEventBus:
    def __init__(self):
        self._handlers = {}
        self.subscribe_calls = []

    def subscribe(self, event_type, handler):
        self.subscribe_calls.append((event_type, handler))
        self._handlers.setdefault(event_type, []).append(handler)


def test_subscription_task_event_handler_registration_is_idempotent(monkeypatch):
    event_bus = FakeEventBus()
    monkeypatch.setattr(
        subscription_tasks, "_subscription_event_handlers_registered", False
    )
    monkeypatch.setattr("app.core.events.get_event_bus", lambda: event_bus)

    subscription_tasks._ensure_subscription_task_event_handlers_registered()
    subscription_tasks._ensure_subscription_task_event_handlers_registered()

    assert event_bus.subscribe_calls == [(TaskCompletedEvent, handle_task_completed)]


def test_subscription_task_event_handler_registration_reuses_existing_handler(
    monkeypatch,
):
    event_bus = FakeEventBus()
    event_bus._handlers[TaskCompletedEvent] = [handle_task_completed]
    monkeypatch.setattr(
        subscription_tasks, "_subscription_event_handlers_registered", False
    )
    monkeypatch.setattr("app.core.events.get_event_bus", lambda: event_bus)

    subscription_tasks._ensure_subscription_task_event_handlers_registered()

    assert event_bus.subscribe_calls == []


def test_subscription_handler_recovers_when_bus_loses_registered_handlers(
    monkeypatch,
):
    event_bus = FakeEventBus()
    monkeypatch.setattr("app.core.events.get_event_bus", lambda: event_bus)
    monkeypatch.setattr(
        subscription_tasks,
        "_subscription_event_handlers_registered",
        True,
    )

    subscription_tasks._ensure_subscription_task_event_handlers_registered()

    assert event_bus.subscribe_calls == [(TaskCompletedEvent, handle_task_completed)]


def test_standalone_worker_initializes_subscription_completion_handler(monkeypatch):
    event_bus = FakeEventBus()
    monkeypatch.setattr(
        subscription_tasks, "_subscription_event_handlers_registered", False
    )
    monkeypatch.setattr("app.core.events.get_event_bus", lambda: event_bus)

    from app.core.celery_app import register_subscription_completion_handlers

    register_subscription_completion_handlers()

    assert event_bus.subscribe_calls == [(TaskCompletedEvent, handle_task_completed)]
