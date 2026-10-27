# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Catalog publication retries deadlocked MySQL transactions."""

import pytest
from sqlalchemy.exc import OperationalError

from app.services.plugin_marketplace_service import plugin_marketplace_service


class _MysqlError(Exception):
    """Stand-in for PyMySQL's error with a numeric code."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(code, message)


class _Session:
    def __init__(self) -> None:
        self.rollbacks = 0

    def rollback(self) -> None:
        self.rollbacks += 1


def _operational_error(code: int, message: str) -> OperationalError:
    return OperationalError("flush", {}, _MysqlError(code, message))


def test_publish_catalog_release_retries_a_deadlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Session()
    attempts: list[int] = []

    def publish_once(*_args: object, **_kwargs: object) -> str:
        attempts.append(1)
        if len(attempts) == 1:
            raise _operational_error(1213, "Deadlock found when trying to get lock")
        return "published"

    monkeypatch.setattr(
        plugin_marketplace_service, "_publish_catalog_release_once", publish_once
    )

    result = plugin_marketplace_service.publish_catalog_release(
        db,  # type: ignore[arg-type]
        catalog_namespace="official",
        slug="deadlock-demo",
        package=b"",
    )

    assert result == "published"
    assert len(attempts) == 2
    assert db.rollbacks == 1


def test_publish_catalog_release_does_not_retry_other_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _Session()
    attempts: list[int] = []

    def publish_once(*_args: object, **_kwargs: object) -> str:
        attempts.append(1)
        raise _operational_error(1205, "Lock wait timeout exceeded")

    monkeypatch.setattr(
        plugin_marketplace_service, "_publish_catalog_release_once", publish_once
    )

    with pytest.raises(OperationalError):
        plugin_marketplace_service.publish_catalog_release(
            db,  # type: ignore[arg-type]
            catalog_namespace="official",
            slug="deadlock-demo",
            package=b"",
        )

    assert len(attempts) == 1
    assert db.rollbacks == 0
