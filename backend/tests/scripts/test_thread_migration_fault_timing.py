"""The real SQL fault window starts after the CLI persists its asset receipt."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def observation(monkeypatch):
    path = (
        Path(__file__).resolve().parents[3]
        / "wework/e2e/desktop/fixtures/thread-migration-assets.py"
    )
    spec = importlib.util.spec_from_file_location("thread_migration_fixture", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    clock = SimpleNamespace(now=0.0, next_step=1.0)

    def wait(_interval):
        clock.now += clock.next_step

    monkeypatch.setattr(module, "monotonic", lambda: clock.now)
    monkeypatch.setattr(module, "Event", lambda: SimpleNamespace(wait=wait))
    return module.history_insert_observation_deadline, clock


def test_slow_preparation_keeps_the_full_sql_observation_window(observation):
    deadline, clock = observation
    process = SimpleNamespace(poll=lambda: None)
    receipt = SimpleNamespace(is_file=lambda: clock.now >= 21)

    sql_deadline = deadline(process, receipt)

    assert clock.now == 21
    assert sql_deadline == 41
    clock.now = 40.99
    assert clock.now < sql_deadline
    clock.now = 41
    assert not clock.now < sql_deadline


def test_ready_receipt_does_not_add_a_wait(observation):
    deadline, clock = observation
    process = SimpleNamespace(poll=lambda: None)
    receipt = SimpleNamespace(is_file=lambda: True)

    assert deadline(process, receipt) == 20
    assert clock.now == 0


def test_missing_receipt_fails_at_the_preparation_boundary(observation):
    deadline, clock = observation
    process = SimpleNamespace(poll=lambda: None)
    receipt = SimpleNamespace(is_file=lambda: False)

    with pytest.raises(AssertionError, match="persist receipts within 30 seconds"):
        deadline(process, receipt)

    assert clock.now == 30


def test_receipt_after_a_late_wakeup_cannot_extend_preparation(observation):
    deadline, clock = observation
    process = SimpleNamespace(poll=lambda: None)
    clock.next_step = 31
    receipt = SimpleNamespace(is_file=lambda: clock.now >= 31)

    with pytest.raises(AssertionError, match="persist receipts within 30 seconds"):
        deadline(process, receipt)

    assert clock.now == 31


@pytest.mark.parametrize("receipt_exists", [False, True])
def test_exited_writer_cannot_start_the_sql_window(observation, receipt_exists):
    deadline, clock = observation
    process = SimpleNamespace(poll=lambda: 1, communicate=lambda: ("", "CLI failed"))
    receipt = SimpleNamespace(is_file=lambda: receipt_exists)

    with pytest.raises(AssertionError, match="before receipt preparation.*CLI failed"):
        deadline(process, receipt)

    assert clock.now == 0
