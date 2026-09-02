# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Static ownership gates for the isolated IM channel process."""

from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[2]
WEB_PROCESS_FILES = (
    BACKEND_ROOT / "app/main.py",
    BACKEND_ROOT / "app/api/endpoints/admin/im_channels.py",
    BACKEND_ROOT / "app/services/channels/device_notification.py",
)


def test_web_process_files_do_not_reference_channel_manager() -> None:
    forbidden = ("get_channel_manager", "ChannelManager")

    violations = {
        str(path.relative_to(BACKEND_ROOT)): [
            symbol for symbol in forbidden if symbol in path.read_text()
        ]
        for path in WEB_PROCESS_FILES
    }

    assert not any(violations.values()), violations


def test_channel_worker_is_the_provider_lifecycle_owner() -> None:
    source = (BACKEND_ROOT / "app/channel_worker.py").read_text()

    assert "ChannelManager.get_instance()" in source
    assert "await manager.start_all_enabled()" in source
    assert "await manager.stop_all()" in source
