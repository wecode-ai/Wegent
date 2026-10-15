import pytest
from pydantic import ValidationError

from app.schemas.device import (
    DeviceHeartbeatPayload,
    DeviceRegisterPayload,
    RuntimeFeatures,
)


@pytest.mark.parametrize(
    "payload_type", [DeviceRegisterPayload, DeviceHeartbeatPayload]
)
@pytest.mark.parametrize(
    "malformed",
    [
        {"worktrees": {"version": "invalid"}},
        {"schemaVersion": "invalid"},
        {"schemaVersion": None},
    ],
)
def test_invalid_feature_envelope_never_erases_explicit_project_denials(
    payload_type, malformed
):
    features = {
        "schemaVersion": 4,
        "projectEditing": {
            "multiRoots": False,
            "aiSettings": False,
            "defaultProjectSpace": False,
            "plugins": False,
        },
        **malformed,
    }
    with pytest.raises(ValidationError):
        RuntimeFeatures.model_validate(features)
    payload = payload_type.model_validate(
        {
            "device_id": "legacy",
            "name": "Legacy",
            "executor_version": "1.8.6",
            "runtime_features": features,
        }
    )
    assert payload.runtime_features is not None
    normalized = payload.runtime_features.model_dump(by_alias=True, exclude_none=True)
    assert normalized["projectEditing"] == features["projectEditing"]
    assert "worktrees" not in normalized


def test_invalid_envelope_preserves_denials_without_authorizing_other_project_flags():
    payload = DeviceHeartbeatPayload.model_validate(
        {
            "device_id": "legacy",
            "executor_version": "1.8.6",
            "runtime_features": {
                "projectEditing": {"multiRoots": False, "aiSettings": True},
                "interactiveSessions": {"terminal": True},
            },
        }
    )
    assert payload.runtime_features is not None
    assert payload.runtime_features.model_dump(by_alias=True, exclude_none=True) == {
        "schemaVersion": 1,
        "projectEditing": {"multiRoots": False},
    }


def test_absent_project_editing_does_not_mask_verified_legacy_support():
    features = RuntimeFeatures.model_validate({"schemaVersion": 4})
    assert "projectEditing" not in features.model_dump(by_alias=True)


@pytest.mark.parametrize("value", [None, "invalid", {"multiRoots": "true"}])
def test_malformed_explicit_project_editing_retains_conservative_advertisement(value):
    features = RuntimeFeatures.model_validate(
        {"schemaVersion": 4, "projectEditing": value}
    )
    assert features.project_editing is not None
    assert features.project_editing.multi_roots is None
    assert "projectEditing" in features.model_dump(by_alias=True, exclude_none=True)


def test_partial_flags_preserve_false_without_authorizing_missing_features():
    features = RuntimeFeatures.model_validate(
        {"schemaVersion": 4, "projectEditing": {"multiRoots": True, "plugins": False}}
    )
    assert features.model_dump(by_alias=True, exclude_none=True)["projectEditing"] == {
        "multiRoots": True,
        "plugins": False,
    }
