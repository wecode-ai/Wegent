# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.schemas.device import (
    DeviceCapabilitySyncResult,
    DeviceHeartbeatPayload,
    DeviceRegisterPayload,
    RuntimeFeatures,
)


@pytest.mark.parametrize(
    "payload_type", [DeviceRegisterPayload, DeviceHeartbeatPayload]
)
def test_plugin_protocol_advertisement_survives_registration_and_heartbeat(
    payload_type,
):
    payload = payload_type.model_validate(
        {
            "device_id": "new-client",
            "name": "Client",
            "executor_version": "test",
            "runtime_features": {
                "schemaVersion": 4,
                "pluginSync": {"protocolVersion": 2, "unknown": True},
            },
        }
    )
    assert payload.runtime_features.model_dump(by_alias=True, exclude_none=True) == {
        "schemaVersion": 4,
        "pluginSync": {"protocolVersion": 2},
    }


@pytest.mark.parametrize(
    "advertisement",
    [None, [], "2", {}, {"protocolVersion": True}, {"protocolVersion": "2"}],
)
def test_malformed_plugin_advertisement_does_not_erase_other_features(advertisement):
    features = RuntimeFeatures.model_validate(
        {
            "schemaVersion": 4,
            "pluginSync": advertisement,
            "projectEditing": {"plugins": False},
        }
    )
    normalized = features.model_dump(by_alias=True, exclude_none=True)
    assert "pluginSync" not in normalized
    assert normalized["projectEditing"] == {"plugins": False}


def test_legacy_features_and_sync_ack_keep_existing_serialization():
    assert "pluginSync" not in RuntimeFeatures(schemaVersion=4).model_dump(
        by_alias=True
    )
    result = DeviceCapabilitySyncResult(
        device_id="legacy",
        success=True,
        plugins=[{"id": 123, "status": "synced"}],
    ).model_dump()
    assert "plugin_sync" not in result
    assert all(
        field not in result["plugins"][0]
        for field in ("generation", "version", "checksum", "operation")
    )


def test_versioned_sync_ack_retains_snapshot_and_materialized_identity():
    result = DeviceCapabilitySyncResult.model_validate(
        {
            "device_id": "new-client",
            "success": True,
            "plugin_sync": {"version": 2, "generation": 12, "complete": False},
            "plugins": [
                {
                    "id": 123,
                    "status": "synced",
                    "generation": 12,
                    "version": "1.0.0",
                    "checksum": "abcdef",
                    "operation": "upsert",
                }
            ],
        }
    ).model_dump(exclude_none=True)
    assert result["plugin_sync"] == {
        "version": 2,
        "generation": 12,
        "complete": False,
    }
    assert result["plugins"] == [
        {
            "id": 123,
            "status": "synced",
            "generation": 12,
            "version": "1.0.0",
            "checksum": "abcdef",
            "operation": "upsert",
        }
    ]
