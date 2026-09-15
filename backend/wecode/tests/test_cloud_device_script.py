# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud device startup script generation."""

import base64
import logging
import subprocess

from wecode.service.cloud_device_script import generate_simple_startup_script


def _git_account(
    domain: str,
    token: str,
    *,
    login: str = "alice",
    email: str | None = "alice@example.com",
) -> dict[str, str | None]:
    return {
        "domain": domain,
        "host": domain,
        "provider": "gitlab",
        "token": token,
        "username": login or "oauth2",
        "identity_name": login or None,
        "identity_email": email,
    }


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


def test_simple_startup_script_exports_cloud_worktree_runtime_environment():
    """Managed cloud devices should advertise verified persistent Worktrees."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        device_id="cloud-device-id",
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'export DEVICE_TYPE="cloud"' in script
    assert 'export WEGENT_EXECUTOR_HOME="/home/ubuntu/.wegent-executor"' in script
    assert (
        'export LOCAL_WORKSPACE_ROOT="/home/ubuntu/.wegent-executor/workspace"'
        in script
    )
    assert 'export WEGENT_EXECUTOR_HOME_ID="cloud-device-id"' in script
    assert 'export WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED="true"' in script


def test_simple_startup_script_sets_ubuntu_password():
    """Cloud device user_data should set the ubuntu user's login password."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        ubuntu_password="new-ubuntu-password",
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'echo "ubuntu:new-ubuntu-password" | sudo chpasswd' in script


def test_simple_startup_script_configures_daily_fstrim_timer():
    """Cloud device user_data should configure fstrim.timer to run daily."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert "mkdir -p /etc/systemd/system/fstrim.timer.d" in script
    assert "cat > /etc/systemd/system/fstrim.timer.d/override.conf << 'EOF'" in script
    assert "OnCalendar=daily" in script
    assert "systemctl daemon-reload" in script
    assert "systemctl restart fstrim.timer" in script
    assert "systemctl enable fstrim.timer" in script


def test_simple_startup_script_exports_git_token_environment():
    """Cloud device user_data should expose git tokens as domain-specific env vars."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[
            _git_account("git.intra.weibo.com", "git-intra-token"),
            _git_account("git.staff.sina.com.cn", "git-staff-token"),
            _git_account("gitlab.weibo.cn", "gitlab-weibo-token"),
        ],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'export GIT_INTRA_WEIBO_COM_TOKEN="git-intra-token"' in script
    assert 'export GIT_STAFF_SINA_COM_CN_TOKEN="git-staff-token"' in script
    assert 'export GITLAB_WEIBO_CN_TOKEN="gitlab-weibo-token"' in script


def test_simple_startup_script_exports_git_tokens_without_xtrace():
    """Git token exports should not be traced into cloud-init logs."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[_git_account("git.intra.weibo.com", "git-intra-token")],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert (
        "# Export git tokens without shell xtrace leaking values\n"
        "set +x\n"
        'export GIT_INTRA_WEIBO_COM_TOKEN="git-intra-token"\n'
        "set -x"
    ) in script


def test_simple_startup_script_configures_git_token_clone_support():
    """Cloud device should use the shared managed Git account configuration."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[
            _git_account(
                "git.intra.weibo.com",
                "git-intra-token",
                login="alice-intra",
                email="alice@intra.example.com",
            ),
            _git_account(
                "gitlab.weibo.cn",
                "gitlab-weibo-token",
                login="alice-weibo",
                email="alice@weibo.example.com",
            ),
        ],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert (
        "Configure managed Git authentication and per-domain commit identities"
        in script
    )
    assert '"identity_name":"alice-intra"' in script
    assert '"identity_email":"alice@intra.example.com"' in script
    assert '"identity_name":"alice-weibo"' in script
    assert '"identity_email":"alice@weibo.example.com"' in script
    assert "git-auth/current/credential-helper" in script
    assert 'ASKPASS_SCRIPT="$HOME/.wecode/git-askpass.sh"' not in script


def test_simple_startup_script_keeps_git_account_payload_out_of_xtrace():
    """The managed account payload and command must not be traced."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[_git_account("git.intra.weibo.com", "git-intra-token")],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    managed_section = script.split(
        "# Configure managed Git authentication and per-domain commit identities",
        1,
    )[1].split("# Export server-generated device ID and name", 1)[0]
    assert managed_section.lstrip().startswith("set +x")
    assert "git-intra-token" in managed_section
    assert managed_section.rstrip().endswith("set -x")


def test_simple_startup_script_persists_git_token_clone_support_for_new_shells():
    """Managed credentials should replace the legacy AskPass profile setup."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[_git_account("git.intra.weibo.com", "git-intra-token")],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert "$HOME/.wecode/git-auth" in script
    assert 'GIT_TOKEN_ENV_FILE="$HOME/.wecode/git-token-env"' not in script
    assert 'ASKPASS_SCRIPT="$HOME/.wecode/git-askpass.sh"' not in script
    assert 'export GIT_INTRA_WEIBO_COM_TOKEN="git-intra-token"' in script


def test_simple_startup_script_uses_per_domain_git_username():
    """Managed credentials should authenticate with the matching Git account."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[
            _git_account(
                "git.intra.weibo.com",
                "git-intra-token",
                login="alice-intra",
            )
        ],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert '"username":"alice-intra"' in script
    assert 'export WEGENT_GIT_USERNAME="alice"' not in script


def test_simple_startup_script_with_managed_git_accounts_has_valid_bash_syntax():
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[
            _git_account(
                "git.intra.weibo.com",
                "token-with-'quotes-$and-specials",
                login="alice-intra",
                email="alice@intra.example.com",
            )
        ],
    )

    script = base64.b64decode(encoded).decode("utf-8")
    result = subprocess.run(
        ["bash", "-n"],
        input=script,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


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


def test_simple_startup_script_logs_length_without_git_token_secrets(caplog):
    """Startup script generation logs must not expose git token values."""
    caplog.set_level(logging.INFO, logger="wecode.service.cloud_device_script")

    generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[
            {
                "type": "gitlab",
                "git_domain": "git.intra.weibo.com",
                "git_token": "git-intra-token",
            }
        ],
    )

    log_text = caplog.text
    assert "Generated simple startup script" in log_text
    assert "git-intra-token" not in log_text


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
