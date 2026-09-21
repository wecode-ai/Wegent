# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for external connection persistence on the existing Kind table."""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.external_source_connections import (
    EXTERNAL_SOURCE_CONNECTION_KIND,
    ExternalSourceConnectionService,
    external_source_connection_service,
)


@pytest.fixture(autouse=True)
def fake_connection_crypto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.external_source_connections.encrypt_sensitive_data",
        lambda value: f"encrypted:{value}",
    )
    monkeypatch.setattr(
        "app.services.external_source_connections.decrypt_sensitive_data",
        lambda value: value.removeprefix("encrypted:"),
    )


def _save(db: Session, user: User, display_name: str):
    return external_source_connection_service.save_owned(
        db,
        owner_user_id=user.id,
        provider_id="wiki",
        display_name=display_name,
        adapter_type="wikijs",
        enabled=True,
        config={"site_url": f"https://{display_name}.example.com"},
        credentials={"api_key": f"key-{display_name}"},
    )


def test_connections_are_scoped_and_credentials_are_encrypted(
    test_db: Session, test_user: User, test_admin_user: User
) -> None:
    first = _save(test_db, test_user, "engineering")
    _save(test_db, test_admin_user, "admin")

    owned = external_source_connection_service.list_owned(
        test_db, owner_user_id=test_user.id, provider_id="wiki"
    )
    row = test_db.get(Kind, first.row.id)

    assert [item.display_name for item in owned] == ["engineering"]
    assert row.kind == EXTERNAL_SOURCE_CONNECTION_KIND
    assert row.namespace == "wiki"
    encrypted = row.json["spec"]["credentialsEncrypted"]["api_key"]
    assert encrypted == "encrypted:key-engineering"
    assert owned[0].credentials["api_key"] == "key-engineering"


def test_blank_credential_update_preserves_stored_secret(
    test_db: Session, test_user: User
) -> None:
    existing = _save(test_db, test_user, "engineering")

    updated = external_source_connection_service.save_owned(
        test_db,
        owner_user_id=test_user.id,
        provider_id="wiki",
        connection_id=existing.connection_id,
        display_name="engineering-v2",
        adapter_type="wikijs",
        enabled=True,
        config={"site_url": "https://engineering-v2.example.com"},
        credentials={"api_key": ""},
    )

    assert updated.display_name == "engineering-v2"
    assert updated.credentials["api_key"] == "key-engineering"
    assert existing.revision == 1
    assert updated.revision == 2
    assert updated.row.json["spec"]["revision"] == 2


def test_connection_update_locks_row_before_incrementing_revision(
    test_db: Session, test_user: User
) -> None:
    existing = _save(test_db, test_user, "engineering")

    with patch.object(
        ExternalSourceConnectionService,
        "get_owned",
        wraps=ExternalSourceConnectionService.get_owned,
    ) as get_owned:
        external_source_connection_service.save_owned(
            test_db,
            owner_user_id=test_user.id,
            provider_id="wiki",
            connection_id=existing.connection_id,
            display_name="engineering-v2",
            adapter_type="wikijs",
            enabled=True,
            config={"site_url": "https://engineering-v2.example.com"},
            credentials={"api_key": ""},
        )

    get_owned.assert_called_once_with(
        test_db,
        owner_user_id=test_user.id,
        provider_id="wiki",
        connection_id=existing.connection_id,
        include_inactive=True,
        for_update=True,
    )


def test_disable_hides_connection_without_deleting_kind_row(
    test_db: Session, test_user: User
) -> None:
    existing = _save(test_db, test_user, "engineering")

    disabled = external_source_connection_service.disable_owned(
        test_db,
        owner_user_id=test_user.id,
        provider_id="wiki",
        connection_id=existing.connection_id,
    )

    assert disabled is True
    assert (
        external_source_connection_service.get_owned(
            test_db,
            owner_user_id=test_user.id,
            provider_id="wiki",
            connection_id=existing.connection_id,
        )
        is None
    )
    assert test_db.get(Kind, existing.row.id) is not None


def test_explicit_connection_id_cannot_bypass_connection_limit(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "app.services.external_source_connections.MAX_EXTERNAL_SOURCE_CONNECTIONS", 1
    )
    _save(test_db, test_user, "engineering")

    with pytest.raises(ValueError, match="limit reached"):
        external_source_connection_service.save_owned(
            test_db,
            owner_user_id=test_user.id,
            provider_id="wiki",
            connection_id="legacy-primary",
            create_if_missing=True,
            display_name="legacy",
            adapter_type="wikijs",
            enabled=True,
            config={"site_url": "https://legacy.example.com"},
            credentials={"api_key": "legacy-key"},
        )


def test_inactive_connection_cannot_be_reactivated_above_connection_limit(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "app.services.external_source_connections.MAX_EXTERNAL_SOURCE_CONNECTIONS", 1
    )
    inactive = _save(test_db, test_user, "inactive")
    external_source_connection_service.disable_owned(
        test_db,
        owner_user_id=test_user.id,
        provider_id="wiki",
        connection_id=inactive.connection_id,
    )
    _save(test_db, test_user, "active")

    with pytest.raises(ValueError, match="limit reached"):
        external_source_connection_service.save_owned(
            test_db,
            owner_user_id=test_user.id,
            provider_id="wiki",
            connection_id=inactive.connection_id,
            display_name="reactivated",
            adapter_type="wikijs",
            enabled=True,
            config={"site_url": "https://reactivated.example.com"},
            credentials={"api_key": "new-key"},
        )
