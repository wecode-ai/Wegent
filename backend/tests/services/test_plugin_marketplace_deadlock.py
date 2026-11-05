# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Catalog publication retries deadlocked MySQL transactions."""

import hashlib
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import OperationalError

from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_publication_artifact import expected_release_idempotency_key
from app.services.plugin_publication_service import plugin_publication_service


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
    assert db.rollbacks >= 1


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


def test_deferred_catalog_release_propagates_deadlocks() -> None:
    """A deferred caller owns the transaction, so the publish must not rollback."""
    db = _Session()

    def publish_once(*_args: object, **_kwargs: object) -> str:
        raise _operational_error(1213, "Deadlock found when trying to get lock")

    original = plugin_marketplace_service._publish_catalog_release_once
    plugin_marketplace_service._publish_catalog_release_once = publish_once
    try:
        with pytest.raises(OperationalError):
            plugin_marketplace_service.publish_catalog_release(
                db,  # type: ignore[arg-type]
                catalog_namespace="official",
                slug="deadlock-demo",
                package=b"",
                defer_commit=True,
            )
    finally:
        plugin_marketplace_service._publish_catalog_release_once = original

    assert db.rollbacks == 0


def _release_metadata(package: bytes) -> SimpleNamespace:
    digest = hashlib.sha256(package).hexdigest()
    payload = {
        "source": {"projectId": "42", "sourceCommitSha": "a" * 40},
        "artifact": {"sha256": digest},
    }
    return SimpleNamespace(
        model_dump=lambda mode: payload,
        artifact=SimpleNamespace(sha256=digest),
        plugin=SimpleNamespace(
            slug="deadlock-demo", listingType="plugin", version="1.0.0"
        ),
        source=SimpleNamespace(
            sourceCommitSha="a" * 40,
            projectId="42",
            ref="main",
            pipelineId="7",
            pipelineUrl="https://example.test/pipeline/7",
            metadata=SimpleNamespace(model_dump=lambda: {}),
        ),
        requestId="request-1",
        revision=1,
    )


def test_enterprise_release_retries_deadlock_from_the_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A deadlock must restart the claim so the binding and source stay locked."""
    package = b"package"
    metadata = _release_metadata(package)
    service = plugin_publication_service
    db = _Session()
    db.commit = lambda: setattr(db, "commits", getattr(db, "commits", 0) + 1)  # type: ignore[attr-defined]
    calls = {"claim": 0, "publish": 0}

    class Binding:
        status = "processing"
        response_json: dict[str, object] = {}
        plugin_id: int | None = None
        release_id: int | None = None
        last_error = ""

    binding = Binding()

    def claim(*_args: object, **_kwargs: object) -> tuple[Binding, None]:
        calls["claim"] += 1
        return binding, None

    def publish(*_args: object, **_kwargs: object) -> SimpleNamespace:
        calls["publish"] += 1
        if calls["publish"] == 1:
            raise _operational_error(1213, "Deadlock found when trying to get lock")
        return SimpleNamespace(
            release=SimpleNamespace(id=7, plugin_id=9, version="1.0.0"), created=True
        )

    monkeypatch.setattr(service, "_claim_release_idempotency", claim)
    monkeypatch.setattr(
        service, "_authorize_release_provenance", lambda *_a, **_k: (None, None)
    )
    monkeypatch.setattr(service, "_event", lambda *_a, **_k: None)
    monkeypatch.setattr(service.marketplace, "publish_catalog_release", publish)
    monkeypatch.setattr(service.marketplace, "notify_catalog_release", lambda *_a: None)

    response = service.publish_enterprise_release(
        db,  # type: ignore[arg-type]
        package=package,
        metadata=metadata,  # type: ignore[arg-type]
        idempotency_key=expected_release_idempotency_key(
            metadata.model_dump(mode="json")
        ),
        release_key_id=5,
    )

    assert response.releaseId == 7
    assert calls == {"claim": 2, "publish": 2}
    assert db.rollbacks >= 1
    assert getattr(db, "commits", 0) == 1
    assert binding.status == "completed"
