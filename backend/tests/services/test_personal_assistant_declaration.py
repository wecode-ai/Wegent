"""Persist assistant consent only through the authenticated user's Device."""

from copy import deepcopy

from app.models.kind import Kind
from app.schemas.personal_assistant_dispatch import PersonalAssistantDispatchFeatures
from app.services.device.personal_assistant_dispatch import (
    persist_personal_assistant_dispatch,
)
from tests.schemas.test_personal_assistant_dispatch_features import declaration


def device(user_id: int, name: str, namespace: str = "default") -> Kind:
    return Kind(
        user_id=user_id,
        kind="Device",
        namespace=namespace,
        name=name,
        is_active=True,
        json={"spec": {"deviceId": name, "displayName": "Test device"}},
    )


def test_persist_filters_other_accounts_and_preserves_device_settings(
    test_db, test_user
):
    owner = test_user.id
    owned = device(owner, "owned-device")
    unrelated = device(owner + 1, "owned-device")
    other_namespace = device(owner, "owned-device", "other")
    test_db.add_all([owned, unrelated, other_namespace])
    test_db.flush()
    unrelated_before = deepcopy(unrelated.json)
    other_namespace_before = deepcopy(other_namespace.json)
    metadata = declaration(owner)
    metadata["roles"].extend(declaration(owner + 1)["roles"])
    advertisement = PersonalAssistantDispatchFeatures.model_validate(metadata)

    assert persist_personal_assistant_dispatch(
        test_db, user_id=owner, device_id=owned.name, advertisement=advertisement
    )

    spec = owned.json["spec"]
    assert spec["displayName"] == "Test device"
    assert [role["userId"] for role in spec["personalAssistantDispatch"]["roles"]] == [
        owner
    ]
    assert unrelated.json == unrelated_before
    assert other_namespace.json == other_namespace_before
    assert not persist_personal_assistant_dispatch(
        test_db, user_id=owner, device_id=owned.name, advertisement=advertisement
    )


def test_foreign_device_cannot_receive_consent_and_empty_declaration_revokes(
    test_db, test_user
):
    owned = device(test_user.id, "owned")
    foreign = device(test_user.id + 1, "foreign")
    test_db.add_all([owned, foreign])
    test_db.flush()
    advertisement = PersonalAssistantDispatchFeatures.model_validate(
        declaration(test_user.id)
    )
    assert not persist_personal_assistant_dispatch(
        test_db,
        user_id=test_user.id,
        device_id=foreign.name,
        advertisement=advertisement,
    )
    persist_personal_assistant_dispatch(
        test_db,
        user_id=test_user.id,
        device_id=owned.name,
        advertisement=advertisement,
    )

    assert persist_personal_assistant_dispatch(
        test_db,
        user_id=test_user.id,
        device_id=owned.name,
        advertisement=PersonalAssistantDispatchFeatures(version=1, roles=[]),
    )
    assert owned.json["spec"]["personalAssistantDispatch"]["roles"] == []
