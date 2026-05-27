# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud device startup script generation."""

import base64
import logging

from wecode.service.cloud_device_script import generate_simple_startup_script


def test_simple_startup_script_exports_current_user_identity():
    """Cloud device user_data should expose current user identity to the VM."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        user_jwt_token="jwt-token-for-alice",
        install_script_url="https://example.com/install.sh",
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'export WEGENT_USER_JWT_TOKEN="jwt-token-for-alice"' in script
    assert 'export WEGENT_USER_NAME="alice"' in script
    assert '-t "device-api-key"' in script


def test_simple_startup_script_logs_length_without_secrets(caplog):
    """Startup script generation logs must not expose token values."""
    caplog.set_level(logging.INFO, logger="wecode.service.cloud_device_script")

    generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        user_jwt_token="jwt-token-for-alice",
        install_script_url="https://example.com/install.sh",
    )

    log_text = caplog.text
    assert "Generated simple startup script" in log_text
    assert "device-api-key" not in log_text
    assert "jwt-token-for-alice" not in log_text


def test_simple_startup_script_includes_sinawatch_install():
    """Startup script must include Sinawatch monitoring agent installation."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'echo "asset_number=$(hostname)" | tee /etc/sinainstall.conf' in script
    assert "sina-watchagent_latest_amd64.deb" in script
    assert "/usr/bin/dpkg -i /tmp/sina-watchagent.deb" in script
    assert "rm -f /tmp/sina-watchagent.deb" in script
