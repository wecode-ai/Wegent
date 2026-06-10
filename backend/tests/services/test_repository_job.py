from contextlib import contextmanager

import pytest

from app.models.kind import Kind
from app.models.user import User
from app.services import repository_job as repository_job_module
from app.services.repository_job import RepositoryJobService, UserRepositorySnapshot


class FakeSession:
    def __init__(self, rollback_raises: bool = False) -> None:
        self._in_transaction = True
        self.rollback_called = False
        self.close_called = False
        self.rollback_raises = rollback_raises

    def in_transaction(self) -> bool:
        return self._in_transaction

    def rollback(self) -> None:
        self.rollback_called = True
        if self.rollback_raises:
            raise RuntimeError("rollback failed")
        self._in_transaction = False

    def close(self) -> None:
        self.close_called = True


@contextmanager
def fake_db_session(db: FakeSession):
    try:
        yield db
    finally:
        db.close()


@pytest.mark.asyncio
async def test_repository_job_uses_short_lived_session_for_user_snapshot(
    monkeypatch,
):
    db = FakeSession()
    source_user = User(
        id=1,
        user_name="alice",
        is_active=True,
        git_info=[
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": "token",
            }
        ],
    )
    service = RepositoryJobService(Kind)

    monkeypatch.setattr(
        repository_job_module,
        "get_db_session",
        lambda: fake_db_session(db),
    )
    monkeypatch.setattr(
        repository_job_module.user_service,
        "get_all_users",
        lambda _: [source_user],
    )

    async def fake_process_user(user: UserRepositorySnapshot) -> str:
        assert db.close_called is True
        assert user is not source_user
        assert isinstance(user, UserRepositorySnapshot)
        assert user.id == source_user.id
        assert user.user_name == source_user.user_name
        assert user.git_info == source_user.git_info
        return "success"

    monkeypatch.setattr(service, "_process_user", fake_process_user)

    await service.update_repositories_for_all_users()

    assert db.close_called is True


@pytest.mark.asyncio
async def test_repository_job_closes_snapshot_session_when_snapshot_fails(
    monkeypatch,
):
    db = FakeSession()
    service = RepositoryJobService(Kind)
    source_user = User(
        id=1,
        user_name="alice",
        is_active=True,
        git_info=[],
    )

    monkeypatch.setattr(
        repository_job_module,
        "get_db_session",
        lambda: fake_db_session(db),
    )
    monkeypatch.setattr(
        repository_job_module.user_service,
        "get_all_users",
        lambda _: [source_user],
    )

    def raise_during_snapshot(_users):
        raise RuntimeError("snapshot failed")

    monkeypatch.setattr(service, "_snapshot_users", raise_during_snapshot)

    await service.update_repositories_for_all_users()

    assert db.close_called is True
