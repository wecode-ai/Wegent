"""Business-version compare-and-swap checks for plugin installations."""

from copy import deepcopy

import pytest
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.plugin_kind_revision import kind_revision, replace_installed_kind
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_write_coordination import PluginWriteError


def _install(db, user_id: int, *, revision: int | None) -> Kind:
    spec = {"enabled": True, "componentStates": {"review": False}}
    if revision is not None:
        spec["revision"] = revision
    row = Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        namespace="default",
        name="revision-test",
        json={"spec": spec},
        is_active=True,
    )
    db.add(row)
    db.flush()
    return row


@pytest.mark.parametrize("revision", [None, 4])
def test_install_cas_advances_legacy_and_current_versions(test_db, test_user, revision):
    row = _install(test_db, test_user.id, revision=revision)
    payload = deepcopy(row.json)
    payload["spec"]["enabled"] = False

    replace_installed_kind(test_db, row, payload, is_active=False)
    test_db.flush()
    test_db.refresh(row)

    assert row.json["spec"]["revision"] == (revision or 0) + 1
    assert row.json["spec"]["enabled"] is False
    assert row.json["spec"]["componentStates"] == {"review": False}
    assert row.is_active is False
    assert payload["spec"].get("revision") == revision


def test_stale_install_cas_preserves_the_newer_database_state(test_db, test_user):
    row = _install(test_db, test_user.id, revision=4)
    stale_payload = deepcopy(row.json)
    newer_payload = {"spec": {"revision": 5, "enabled": False}}
    test_db.execute(
        update(Kind.__table__)
        .where(Kind.id == row.id)
        .values(json=newer_payload, is_active=False)
    )

    with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
        replace_installed_kind(test_db, row, stale_payload, is_active=True)

    test_db.refresh(row)
    assert row.json == newer_payload
    assert row.is_active is False


@pytest.mark.parametrize("revision", [None, 4])
def test_revocation_rejects_stale_install_reactivation(test_db, test_user, revision):
    row = _install(test_db, test_user.id, revision=revision)
    with Session(test_db.connection(), join_transaction_mode="create_savepoint") as old:
        stale = old.get(Kind, row.id)
        stale_payload = deepcopy(stale.json)

        PluginMarketplaceService()._deactivate_revoked_installations(
            test_db, [(test_user.id, row.id)]
        )

        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            replace_installed_kind(old, stale, stale_payload, is_active=True)
        test_db.refresh(row)
        assert row.json["spec"]["revision"] == (revision or 0) + 1
        assert row.json["spec"]["installState"] == "uninstalled"
        assert row.json["spec"]["enabled"] is False
        assert row.json["spec"]["componentStates"] == {"review": False}
        assert row.is_active is False


@pytest.mark.parametrize("revision", [-1, True, "4", None])
def test_malformed_install_revision_fails_closed(test_db, test_user, revision):
    row = _install(test_db, test_user.id, revision=0)
    row.json = {"spec": {"revision": revision}}

    with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
        kind_revision(row)
