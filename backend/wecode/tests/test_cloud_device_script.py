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
            {
                "type": "gitlab",
                "git_domain": "git.intra.weibo.com",
                "git_token": "git-intra-token",
            },
            {
                "type": "gitlab",
                "git_domain": "git.staff.sina.com.cn",
                "git_token": "git-staff-token",
            },
            {
                "type": "gitlab",
                "git_domain": "gitlab.weibo.cn",
                "git_token": "gitlab-weibo-token",
            },
            {
                "type": "gitlab",
                "git_domain": "unsupported.example.com",
                "git_token": "unsupported-token",
            },
        ],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'export GIT_INTRA_WEIBO_COM_TOKEN="git-intra-token"' in script
    assert 'export GIT_STAFF_SINA_COM_CN_TOKEN="git-staff-token"' in script
    assert 'export GITLAB_WEIBO_CN_TOKEN="gitlab-weibo-token"' in script
    assert "unsupported-token" not in script


def test_simple_startup_script_exports_git_tokens_without_xtrace():
    """Git token exports should not be traced into cloud-init logs."""
    encoded = generate_simple_startup_script(
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

    script = base64.b64decode(encoded).decode("utf-8")

    assert (
        "# Export git tokens without shell xtrace leaking values\n"
        "set +x\n"
        'export GIT_INTRA_WEIBO_COM_TOKEN="git-intra-token"\n'
        "set -x"
    ) in script


def test_simple_startup_script_configures_git_token_clone_support():
    """Cloud device should rewrite SSH Git URLs to HTTPS and use askpass tokens."""
    encoded = generate_simple_startup_script(
        user_name="alice",
        backend_url="https://backend.example.com",
        auth_token="device-api-key",
        install_script_url="https://example.com/install.sh",
        git_tokens=[
            {
                "type": "gitlab",
                "git_domain": "git.intra.weibo.com",
                "git_token": "git-intra-token",
            },
            {
                "type": "gitlab",
                "git_domain": "gitlab.weibo.cn",
                "git_token": "gitlab-weibo-token",
            },
        ],
    )

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'ASKPASS_SCRIPT="$HOME/.wecode/git-askpass.sh"' in script
    assert 'git config --global core.askPass "$ASKPASS_SCRIPT"' in script
    assert (
        'git config --global --add url."https://git.intra.weibo.com/".insteadOf '
        '"ssh://git@git.intra.weibo.com:2222/"'
    ) in script
    assert (
        'git config --global --add url."https://gitlab.weibo.cn/".insteadOf '
        '"ssh://git@gitlab.weibo.cn/"'
    ) in script
    assert (
        '*Password*git.intra.weibo.com*) echo "$GIT_INTRA_WEIBO_COM_TOKEN" ;;' in script
    )
    assert '*Password*gitlab.weibo.cn*) echo "$GITLAB_WEIBO_CN_TOKEN" ;;' in script
    assert (
        'url."https://oauth2:git-intra-token@git.intra.weibo.com/".insteadOf'
        not in script
    )


def test_simple_startup_script_adds_all_git_url_rewrite_patterns():
    """Git insteadOf is multi-valued, so every SSH pattern must be added."""
    encoded = generate_simple_startup_script(
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

    script = base64.b64decode(encoded).decode("utf-8")

    assert (
        "git config --global --unset-all "
        'url."https://git.intra.weibo.com/".insteadOf || true'
    ) in script
    assert (
        'git config --global --add url."https://git.intra.weibo.com/".insteadOf '
        '"ssh://git@git.intra.weibo.com/"'
    ) in script
    assert (
        'git config --global --add url."https://git.intra.weibo.com/".insteadOf '
        '"ssh://git@git.intra.weibo.com:2222/"'
    ) in script
    assert (
        'git config --global --add url."https://git.intra.weibo.com/".insteadOf '
        '"git@git.intra.weibo.com:"'
    ) in script


def test_simple_startup_script_persists_git_token_clone_support_for_new_shells():
    """New interactive shells should inherit Git token clone support."""
    encoded = generate_simple_startup_script(
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

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'GIT_TOKEN_ENV_FILE="$HOME/.wecode/git-token-env"' in script
    assert 'chmod 600 "$GIT_TOKEN_ENV_FILE"' in script
    assert '. "$GIT_TOKEN_ENV_FILE"' in script
    assert 'export GIT_ASKPASS="$HOME/.wecode/git-askpass.sh"' in script
    assert 'export GIT_INTRA_WEIBO_COM_TOKEN="git-intra-token"' in script
    assert (
        "if ! grep -Fq '# Wegent Git token environment' \"$HOME/.bashrc\"; then"
        in script
    )


def test_simple_startup_script_uses_current_user_for_git_https_username():
    """Git askpass should authenticate HTTPS GitLab clone as the current user."""
    encoded = generate_simple_startup_script(
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

    script = base64.b64decode(encoded).decode("utf-8")

    assert 'export WEGENT_GIT_USERNAME="alice"' in script
    assert (
        '*Username*) echo "${WEGENT_GIT_USERNAME:-${WEGENT_USER_NAME:-oauth2}}" ;;'
        in script
    )


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
