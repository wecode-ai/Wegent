# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.ws.events import ServerEvents
from app.core.constants import get_wework_user_room
from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin, PluginRelease
from app.services.plugin_release_notification_service import (
    notify_plugin_release_available,
    plugin_auto_update_user_ids,
)


class FakeSocketServer:
    def __init__(self) -> None:
        self.emissions: list[dict] = []

    def emit(self, event, payload, *, room, namespace) -> None:
        self.emissions.append(
            {
                "event": event,
                "payload": payload,
                "room": room,
                "namespace": namespace,
            }
        )


def _installed_plugin(
    *,
    user_id: int,
    plugin_id: int,
    release_id: int,
    update_policy: str = "auto",
    source_type: str = "marketplace",
    active: bool = True,
) -> Kind:
    return Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        name=f"plugin-{user_id}",
        namespace="default",
        json={
            "spec": {
                "pluginId": plugin_id,
                "releaseId": release_id,
                "updatePolicy": update_policy,
                "source": {"type": source_type},
            }
        },
        is_active=active,
    )


def _published_release(test_db) -> tuple[Plugin, PluginRelease]:
    plugin = Plugin(
        slug="release-notification",
        name="release-notification",
        display_name="Release notification",
        keywords_json=[],
        interface_json={},
        status="published",
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="2.0.0",
        manifest_json={},
        interface_json={},
        storage_key="plugins/release-notification.zip",
        sha256="a" * 64,
        size_bytes=1,
        status="ready",
        scan_status="passed",
        scan_report_json={},
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id
    test_db.commit()
    return plugin, release


def test_targets_only_outdated_automatic_marketplace_installs(test_db):
    plugin, release = _published_release(test_db)
    test_db.add_all(
        [
            _installed_plugin(
                user_id=11,
                plugin_id=plugin.id,
                release_id=release.id - 1,
            ),
            _installed_plugin(
                user_id=11,
                plugin_id=plugin.id,
                release_id=release.id - 1,
            ),
            _installed_plugin(
                user_id=12,
                plugin_id=plugin.id,
                release_id=release.id - 1,
                update_policy="manual",
            ),
            _installed_plugin(
                user_id=13,
                plugin_id=plugin.id,
                release_id=release.id,
            ),
            _installed_plugin(
                user_id=14,
                plugin_id=plugin.id,
                release_id=release.id - 1,
                source_type="upload",
            ),
            _installed_plugin(
                user_id=15,
                plugin_id=plugin.id,
                release_id=release.id - 1,
                active=False,
            ),
        ]
    )
    test_db.commit()

    assert plugin_auto_update_user_ids(
        test_db,
        plugin_id=plugin.id,
        release_id=release.id,
    ) == [11]


def test_broadcasts_release_to_affected_wework_user_rooms(test_db):
    plugin, release = _published_release(test_db)
    test_db.add(
        _installed_plugin(
            user_id=21,
            plugin_id=plugin.id,
            release_id=release.id - 1,
        )
    )
    test_db.commit()
    socket_server = FakeSocketServer()

    notified = notify_plugin_release_available(
        test_db,
        release.id,
        socket_server=socket_server,
    )

    assert notified == 1
    assert socket_server.emissions == [
        {
            "event": ServerEvents.PLUGIN_RELEASE_AVAILABLE,
            "payload": {
                "pluginId": plugin.id,
                "releaseId": release.id,
                "version": "2.0.0",
            },
            "room": get_wework_user_room(21),
            "namespace": "/chat",
        }
    ]


def test_ignores_a_ready_release_that_is_not_catalog_latest(test_db):
    plugin, release = _published_release(test_db)
    plugin.latest_release_id = release.id + 1
    test_db.add(
        _installed_plugin(
            user_id=31,
            plugin_id=plugin.id,
            release_id=release.id - 1,
        )
    )
    test_db.commit()
    socket_server = FakeSocketServer()

    assert (
        notify_plugin_release_available(
            test_db,
            release.id,
            socket_server=socket_server,
        )
        == 0
    )
    assert socket_server.emissions == []
