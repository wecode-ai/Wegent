# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Runtime feature projection kept separate from capabilities."""

from app.schemas.device import DeviceHeartbeatPayload, DeviceInfo


def _runtime_features():
    return {
        "schemaVersion": 3,
        "runtimeTaskCreate": {
            "schemaVersions": [1, 2],
            "features": {
                "goal": True,
                "supervisor": True,
            },
        },
        "interactiveSessions": {
            "codeServer": False,
            "terminal": True,
        },
        "worktrees": {
            "version": 1,
            "managed": True,
            "deferredPrepare": True,
            "snapshots": True,
            "restore": True,
            "preflight": True,
            "persistentStorageVerified": True,
        },
    }


def test_heartbeat_runtime_features_use_independent_contract():
    payload = DeviceHeartbeatPayload(
        device_id="runtime-cloud",
        capabilities={
            "revision": 2,
            "skills": [{"name": "review"}],
            "plugins": [],
            "mcps": [],
        },
        runtime_features=_runtime_features(),
    )

    assert payload.capabilities["skills"] == [{"name": "review"}]
    assert payload.runtime_features is not None
    assert payload.runtime_features.worktrees is not None
    assert payload.runtime_features.runtime_task_create is not None
    assert payload.runtime_features.runtime_task_create.schema_versions == [1, 2]
    assert payload.runtime_features.runtime_task_create.features["goal"] is True
    assert payload.runtime_features.interactive_sessions is not None
    assert payload.runtime_features.interactive_sessions.code_server is False
    assert payload.runtime_features.interactive_sessions.terminal is True
    assert payload.runtime_features.worktrees.deferred_prepare is True
    assert payload.runtime_features.worktrees.persistent_storage_verified is True
    assert payload.runtime_features.model_dump(by_alias=True) == _runtime_features()


def test_device_info_exposes_only_online_runtime_features():
    info = DeviceInfo(
        id=1,
        device_id="cloud-logical",
        name="Cloud",
        status="online",
        device_type="cloud",
        capabilities=["gpu"],
        runtime_features=_runtime_features(),
    )

    assert info.capabilities == ["gpu"]
    assert info.runtime_features is not None
    assert info.runtime_features.worktrees is not None
    assert info.runtime_features.worktrees.managed is True


def test_worktree_runtime_features_default_persistent_storage_to_unverified():
    info = DeviceInfo(
        id=1,
        device_id="cloud-logical",
        name="Cloud",
        status="online",
        device_type="cloud",
        runtime_features={
            "schemaVersion": 1,
            "worktrees": {
                "version": 1,
                "managed": True,
            },
        },
    )

    assert info.runtime_features is not None
    assert info.runtime_features.worktrees is not None
    assert info.runtime_features.worktrees.persistent_storage_verified is False
    assert (
        info.runtime_features.model_dump(by_alias=True)["worktrees"][
            "persistentStorageVerified"
        ]
        is False
    )


def test_interactive_session_features_default_to_enabled_when_members_are_missing():
    info = DeviceInfo(
        id=1,
        device_id="legacy-runtime",
        name="Legacy",
        status="online",
        device_type="remote",
        runtime_features={
            "schemaVersion": 3,
            "interactiveSessions": {},
        },
    )

    assert info.runtime_features is not None
    assert info.runtime_features.interactive_sessions is not None
    assert info.runtime_features.interactive_sessions.code_server is True
    assert info.runtime_features.interactive_sessions.terminal is True
