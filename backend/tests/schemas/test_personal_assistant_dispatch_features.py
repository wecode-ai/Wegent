"""Device declarations contain consent metadata, never private assistant settings."""

import pytest

from app.schemas.device import (
    DeviceHeartbeatPayload,
    DeviceRegisterPayload,
    RuntimeFeatures,
)


def declaration(user_id: int = 7) -> dict:
    return {
        "version": 1,
        "roles": [
            {
                "id": "@primary",
                "userId": user_id,
                "enabled": True,
                "enabledSince": "2026-11-01T00:00:00Z",
                "version": 3,
                "prompt": "private instructions",
                "connections": [{"secret": "not-a-real-secret"}],
                "collaboration": {
                    "enabled": True,
                    "allProjects": True,
                    "excludedProjects": [{"id": "excluded", "store": "cloud"}],
                    "policy": {"automatic": True, "askBeforeAct": True},
                    "projectPolicies": [
                        {
                            "id": "manual-only",
                            "store": "cloud",
                            "policy": {"automatic": False, "askBeforeAct": True},
                        }
                    ],
                },
                "handlingPolicy": {"automatic": True},
            }
        ],
    }


@pytest.mark.parametrize(
    "payload_type", [DeviceRegisterPayload, DeviceHeartbeatPayload]
)
def test_declaration_preserves_scopes_and_discards_private_configuration(payload_type):
    payload = payload_type.model_validate(
        {
            "device_id": "test-device",
            "name": "Test device",
            "executor_version": "test",
            "runtime_features": {
                "schemaVersion": 4,
                "personalAssistantDispatch": declaration(),
            },
        }
    )
    features = payload.runtime_features.model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    role = features["personalAssistantDispatch"]["roles"][0]
    assert role["userId"] == 7
    assert role["version"] == 3
    assert "prompt" not in role
    assert "connections" not in role
    assert role["collaboration"]["projectPolicies"][0]["policy"]["automatic"] is False
    assert role["collaboration"]["excludedProjects"][0]["id"] == "excluded"


@pytest.mark.parametrize(
    "advertisement",
    [None, {}, {"version": True}, {"version": 2}, {"version": 1, "roles": [{}]}],
)
def test_invalid_explicit_declaration_revokes_previous_authority(advertisement):
    features = RuntimeFeatures.model_validate(
        {
            "schemaVersion": 4,
            "personalAssistantDispatch": advertisement,
            "projectEditing": {"plugins": False},
        }
    ).model_dump(by_alias=True, exclude_none=True)
    assert features["personalAssistantDispatch"] == {"version": 1, "roles": []}
    assert features["projectEditing"]["plugins"] is False


def test_legacy_runtime_has_no_assistant_declaration():
    assert "personalAssistantDispatch" not in RuntimeFeatures(
        schemaVersion=4
    ).model_dump(by_alias=True)


def test_duplicate_alias_cannot_bypass_private_setting_sanitization():
    features = RuntimeFeatures.model_validate(
        {
            "schemaVersion": 4,
            "personalAssistantDispatch": declaration(),
            "personal_assistant_dispatch": {"prompt": "private instructions"},
        }
    ).model_dump(mode="json", by_alias=True, exclude_none=True)
    assert "personal_assistant_dispatch" not in features
    assert "private instructions" not in str(features)


@pytest.mark.parametrize(
    "payload_type", [DeviceRegisterPayload, DeviceHeartbeatPayload]
)
def test_invalid_envelope_revokes_assistant_without_erasing_explicit_denials(
    payload_type,
):
    payload = payload_type.model_validate(
        {
            "device_id": "test-device",
            "name": "Test device",
            "executor_version": "test",
            "runtime_features": {
                "schemaVersion": 4,
                "personalAssistantDispatch": declaration(),
                "projectEditing": {"plugins": False},
                "worktrees": {"version": "invalid"},
            },
        }
    )
    normalized = payload.runtime_features.model_dump(by_alias=True, exclude_none=True)
    assert normalized["personalAssistantDispatch"] == {"version": 1, "roles": []}
    assert normalized["projectEditing"]["plugins"] is False
