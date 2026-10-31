"""Issue creation restarts its transaction when MySQL reports a deadlock."""

from types import SimpleNamespace

import pytest
from sqlalchemy.exc import OperationalError

from app.api.endpoints import deliveries


class _DriverError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(code, message)
        self.args = (code, message)


def _deadlock() -> OperationalError:
    return OperationalError("INSERT", {}, _DriverError(1213, "Deadlock found"))


class _RecordingDb:
    def __init__(self) -> None:
        self.rollbacks = 0

    def rollback(self) -> None:
        self.rollbacks += 1


@pytest.mark.asyncio
async def test_retries_once_after_a_mysql_deadlock(monkeypatch) -> None:
    attempts: list[int] = []

    def create(_db, _project, _user, _values):
        attempts.append(len(attempts) + 1)
        if len(attempts) == 1:
            raise _deadlock()
        return "created"

    monkeypatch.setattr(deliveries.loop_item_provider_router, "create", create)
    db = _RecordingDb()

    created = await deliveries._create_loop_item(
        db, SimpleNamespace(id=7), object(), object()
    )

    assert created == "created"
    assert len(attempts) == 2
    assert db.rollbacks == 1


@pytest.mark.asyncio
async def test_gives_up_after_the_last_attempt(monkeypatch) -> None:
    attempts: list[int] = []

    def create(_db, _project, _user, _values):
        attempts.append(len(attempts) + 1)
        raise _deadlock()

    monkeypatch.setattr(deliveries.loop_item_provider_router, "create", create)
    db = _RecordingDb()

    with pytest.raises(OperationalError):
        await deliveries._create_loop_item(
            db, SimpleNamespace(id=7), object(), object()
        )

    assert len(attempts) == deliveries.LOOP_ITEM_CREATE_ATTEMPTS
    assert db.rollbacks == deliveries.LOOP_ITEM_CREATE_ATTEMPTS - 1


@pytest.mark.asyncio
async def test_does_not_retry_other_database_errors(monkeypatch) -> None:
    attempts: list[int] = []

    def create(_db, _project, _user, _values):
        attempts.append(len(attempts) + 1)
        raise OperationalError("INSERT", {}, _DriverError(1146, "Table missing"))

    monkeypatch.setattr(deliveries.loop_item_provider_router, "create", create)
    db = _RecordingDb()

    with pytest.raises(OperationalError):
        await deliveries._create_loop_item(
            db, SimpleNamespace(id=7), object(), object()
        )

    assert len(attempts) == 1
    assert db.rollbacks == 0
