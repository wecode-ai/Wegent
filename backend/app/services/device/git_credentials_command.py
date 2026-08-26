# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Managed device command for applying user Git credentials."""

import shlex

GIT_CREDENTIALS_SECRET_ENV = "WEGENT_SECRET_GIT_CREDENTIALS"

GIT_CREDENTIAL_SYNC_SCRIPT = r'''
import fcntl
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path


SECRET_ENV = "WEGENT_SECRET_GIT_CREDENTIALS"
MANAGED_START = "# >>> Wegent managed Git authentication >>>"
MANAGED_END = "# <<< Wegent managed Git authentication <<<"
LEGACY_PROFILE_BLOCK = """# Wegent Git token environment
if [ -f "$HOME/.wecode/git-token-env" ]; then
  . "$HOME/.wecode/git-token-env"
fi
export GIT_ASKPASS="$HOME/.wecode/git-askpass.sh"
"""
REWRITE_PROVIDERS = {"github", "gitlab", "gitee", "gitea"}


def emit(payload, exit_code=0):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


def fail(code):
    emit({"error": code}, 1)


def ensure_mode(path, mode):
    path.chmod(mode)


def write_file(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(content, encoding="utf-8")
    ensure_mode(path, mode)


def config_quote(value):
    value = str(value)
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def credential_helper_source():
    return r"""#!/usr/bin/env python3
import json
import sys
from pathlib import Path


if len(sys.argv) < 2 or sys.argv[1] != "get":
    raise SystemExit(0)

request = {}
for raw_line in sys.stdin:
    line = raw_line.rstrip("\n")
    if not line:
        break
    key, separator, value = line.partition("=")
    if separator:
        request[key] = value

if request.get("protocol") != "https":
    raise SystemExit(0)

base = Path(__file__).resolve().parent
manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
account = manifest.get("credentials", {}).get(request.get("host", "").lower())
if not account:
    raise SystemExit(0)

token_path = base / account["token_file"]
token = token_path.read_text(encoding="utf-8")
sys.stdout.write("username=" + account["username"] + "\n")
sys.stdout.write("password=" + token + "\n\n")
"""


def identity_source(name, email):
    return "[user]\n\tname = %s\n\temail = %s\n" % (
        config_quote(name),
        config_quote(email),
    )


def build_git_config(accounts, identity_paths):
    lines = []
    helper = '!f() { exec "$HOME/.wecode/git-auth/current/credential-helper" "$@"; }; f'
    for account in accounts:
        domain = account["domain"]
        host = account["host"]
        lines.extend(
            [
                '[credential "https://%s"]' % domain,
                "\thelper =",
                "\thelper = %s" % config_quote(helper),
                "\tuseHttpPath = false",
                "",
            ]
        )
        if account["provider"] in REWRITE_PROVIDERS:
            lines.extend(
                [
                    '[url "https://%s/"]' % domain,
                    "\tinsteadOf = %s" % config_quote("git@%s:" % host),
                    "\tinsteadOf = %s" % config_quote("ssh://git@%s/" % host),
                    "\tinsteadOf = %s" % config_quote("ssh://git@%s:2222/" % host),
                    "",
                ]
            )

    # Git uses the last matching value. Reverse the include order so the user's
    # first configured account wins when one repository has multiple remotes.
    for account in reversed(accounts):
        identity_path = identity_paths.get(account["domain"])
        if not identity_path:
            continue
        domain = account["domain"]
        host = account["host"]
        patterns = (
            "https://%s/**" % domain,
            "git@%s:**" % host,
            "ssh://git@%s/**" % host,
            "ssh://git@%s:*/**" % host,
        )
        for pattern in patterns:
            lines.extend(
                [
                    '[includeIf "hasconfig:remote.*.url:%s"]' % pattern,
                    "\tpath = %s" % config_quote(str(identity_path)),
                    "",
                ]
            )
    return "\n".join(lines).rstrip() + "\n"


def secure_tree(path):
    if not path.exists():
        return
    for child in path.rglob("*"):
        if child.is_dir():
            ensure_mode(child, 0o700)
        else:
            current_mode = stat.S_IMODE(child.stat().st_mode)
            ensure_mode(child, 0o700 if current_mode & stat.S_IXUSR else 0o600)
    ensure_mode(path, 0o700)


def configure_cli(account, revision):
    provider = account["provider"]
    tool = "gh" if provider == "github" else "glab" if provider == "gitlab" else None
    if not tool:
        return None
    executable = shutil.which(tool)
    if not executable:
        return {
            "provider": tool,
            "domain": account["domain"],
            "status": "not_installed",
            "reason_code": "cli_not_installed",
        }

    config_dir = revision / tool
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = os.environ.copy()
    if tool == "gh":
        environment["GH_CONFIG_DIR"] = str(config_dir)
        command = [
            executable,
            "auth",
            "login",
            "--hostname",
            account["domain"],
            "--git-protocol",
            "https",
            "--with-token",
            "--insecure-storage",
        ]
    else:
        environment["GLAB_CONFIG_DIR"] = str(config_dir)
        command = [
            executable,
            "auth",
            "login",
            "--hostname",
            account["domain"],
            "--git-protocol",
            "https",
            "--stdin",
            "--insecure-storage",
        ]

    try:
        result = subprocess.run(
            command,
            input=account["token"] + "\n",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=30,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    secure_tree(config_dir)
    if result is None or result.returncode != 0:
        return {
            "provider": tool,
            "domain": account["domain"],
            "status": "failed",
            "reason_code": "cli_auth_failed",
        }
    return {
        "provider": tool,
        "domain": account["domain"],
        "status": "configured",
        "reason_code": None,
    }


def snapshot(path):
    if not path.exists():
        return None
    return (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))


def restore(path, saved):
    if saved is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".restore-" + uuid.uuid4().hex)
    temporary.write_bytes(saved[0])
    temporary.chmod(saved[1])
    os.replace(temporary, path)


def strip_managed_blocks(content):
    content = content.replace(LEGACY_PROFILE_BLOCK, "")
    while MANAGED_START in content:
        start = content.index(MANAGED_START)
        end = content.find(MANAGED_END, start)
        if end < 0:
            content = content[:start]
            break
        end += len(MANAGED_END)
        if end < len(content) and content[end] == "\n":
            end += 1
        content = content[:start] + content[end:]
    return content.rstrip() + ("\n" if content.strip() else "")


def update_profile(path, enabled):
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    content = strip_managed_blocks(content)
    if enabled:
        if content and not content.endswith("\n"):
            content += "\n"
        content += (
            MANAGED_START
            + "\n"
            + 'if [ -f "$HOME/.wecode/git-auth/env.sh" ]; then\n'
            + '  . "$HOME/.wecode/git-auth/env.sh"\n'
            + "fi\n"
            + MANAGED_END
            + "\n"
        )
    if content:
        write_file(path, content, mode)
    else:
        path.unlink(missing_ok=True)


def git_config(global_config, *arguments, allow_missing=False):
    environment = os.environ.copy()
    environment["GIT_CONFIG_GLOBAL"] = str(global_config)
    result = subprocess.run(
        ["git", "config", "--global", *arguments],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        env=environment,
    )
    if result.returncode == 0 or (allow_missing and result.returncode in {1, 5}):
        return
    raise RuntimeError("git_config_failed")


def exact_value_pattern(value):
    special = "\\.^$*+?{}[]|()"
    return "^" + "".join("\\" + char if char in special else char for char in value) + "$"


def update_global_git_config(global_config, include_path, enabled, home):
    if not global_config.exists() and not enabled:
        return
    if not global_config.exists():
        write_file(global_config, "", 0o600)
    git_config(
        global_config,
        "--unset-all",
        "include.path",
        exact_value_pattern(str(include_path)),
        allow_missing=True,
    )
    legacy_askpass = str(home / ".wecode" / "git-askpass.sh")
    git_config(
        global_config,
        "--unset-all",
        "core.askPass",
        exact_value_pattern(legacy_askpass),
        allow_missing=True,
    )
    if enabled:
        git_config(global_config, "--add", "include.path", str(include_path))


def read_previous_domains(current, revisions):
    if not current.is_symlink():
        return []
    try:
        target = current.resolve(strict=True)
        target.relative_to(revisions.resolve())
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        return list(manifest.get("domains", []))
    except (OSError, ValueError, json.JSONDecodeError):
        return []


def remove_legacy_files(home, warnings):
    for path in (
        home / ".wecode" / "git-token-env",
        home / ".wecode" / "git-askpass.sh",
    ):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            warnings.append("legacy_cleanup_failed")


def configured_cli_exports(cli_results, root):
    providers = {
        result["provider"]
        for result in cli_results
        if result["status"] == "configured"
    }
    lines = ["#!/bin/sh"]
    if "gh" in providers:
        lines.append('export GH_CONFIG_DIR="$HOME/.wecode/git-auth/current/gh"')
    if "glab" in providers:
        lines.append('export GLAB_CONFIG_DIR="$HOME/.wecode/git-auth/current/glab"')
    return "\n".join(lines) + "\n" if len(lines) > 1 else ""


def clear_managed_state(home, root, current, revisions, global_config, profile_paths):
    previous_domains = read_previous_domains(current, revisions)
    tracked_paths = [global_config, *profile_paths]
    backups = {path: snapshot(path) for path in tracked_paths}
    removed_root = None
    try:
        if root.exists():
            removed_root = root.with_name(root.name + ".removed-" + uuid.uuid4().hex)
            os.replace(root, removed_root)
        update_global_git_config(
            global_config,
            home / ".wecode" / "git-auth" / "current" / "gitconfig",
            False,
            home,
        )
        for path in profile_paths:
            if path.exists():
                update_profile(path, False)
        warnings = []
        remove_legacy_files(home, warnings)
        if removed_root:
            shutil.rmtree(removed_root)
        return previous_domains, warnings
    except Exception:
        for path, saved in backups.items():
            restore(path, saved)
        if removed_root and removed_root.exists() and not root.exists():
            os.replace(removed_root, root)
        raise


def apply_accounts(home, root, current, revisions, global_config, profile_paths, accounts):
    previous_domains = read_previous_domains(current, revisions)
    revision_name = "%d-%s" % (int(time.time()), uuid.uuid4().hex)
    staging = revisions / (".staging-" + revision_name)
    revision = revisions / revision_name
    staging.mkdir(parents=True, mode=0o700)
    tokens_dir = staging / "tokens"
    identities_dir = staging / "identities"
    tokens_dir.mkdir(mode=0o700)
    identities_dir.mkdir(mode=0o700)

    credentials = {}
    identity_paths = {}
    identity_warnings = []
    for account in accounts:
        key = hashlib.sha256(account["domain"].encode("utf-8")).hexdigest()[:24]
        token_path = tokens_dir / key
        write_file(token_path, account["token"], 0o600)
        credentials[account["domain"]] = {
            "username": account["username"],
            "token_file": "tokens/" + key,
        }
        if account.get("identity_name") and account.get("identity_email"):
            identity_path = identities_dir / (key + ".gitconfig")
            write_file(
                identity_path,
                identity_source(account["identity_name"], account["identity_email"]),
                0o600,
            )
            identity_paths[account["domain"]] = (
                root / "current" / "identities" / (key + ".gitconfig")
            )
        else:
            identity_warnings.append(account["domain"])

    manifest = {
        "version": 1,
        "domains": [account["domain"] for account in accounts],
        "credentials": credentials,
    }
    write_file(staging / "manifest.json", json.dumps(manifest, separators=(",", ":")), 0o600)
    write_file(staging / "credential-helper", credential_helper_source(), 0o700)
    write_file(staging / "gitconfig", build_git_config(accounts, identity_paths), 0o600)

    environment = os.environ.copy()
    environment["HOME"] = str(home)
    validation = subprocess.run(
        ["git", "config", "--file", str(staging / "gitconfig"), "--list", "--null"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        env=environment,
    )
    if validation.returncode != 0:
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError("managed_git_config_invalid")

    cli_results = []
    for account in accounts:
        cli_result = configure_cli(account, staging)
        if cli_result:
            cli_results.append(cli_result)

    write_file(staging / "manifest.json", json.dumps(manifest, separators=(",", ":")), 0o600)
    secure_tree(staging)
    os.replace(staging, revision)

    tracked_paths = [global_config, *profile_paths, root / "env.sh"]
    backups = {path: snapshot(path) for path in tracked_paths}
    previous_target = os.readlink(current) if current.is_symlink() else None
    switched = False
    try:
        include_path = root / "current" / "gitconfig"
        update_global_git_config(global_config, include_path, True, home)
        env_source = configured_cli_exports(cli_results, root)
        if env_source:
            write_file(root / "env.sh", env_source, 0o600)
        else:
            (root / "env.sh").unlink(missing_ok=True)
        for path in profile_paths:
            if path == home / ".profile" or path.exists():
                update_profile(path, bool(env_source))

        next_link = root / (".current-" + uuid.uuid4().hex)
        next_link.symlink_to(Path("revisions") / revision_name)
        os.replace(next_link, current)
        switched = True
    except Exception:
        for path, saved in backups.items():
            restore(path, saved)
        if switched:
            current.unlink(missing_ok=True)
            if previous_target:
                current.symlink_to(previous_target)
        shutil.rmtree(revision, ignore_errors=True)
        raise

    warnings = []
    remove_legacy_files(home, warnings)
    for child in revisions.iterdir():
        if child == revision:
            continue
        try:
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        except OSError:
            warnings.append("stale_cleanup_failed")

    return {
        "synced_domains": [account["domain"] for account in accounts],
        "removed_domains": sorted(set(previous_domains) - {account["domain"] for account in accounts}),
        "identity_warning_domains": identity_warnings,
        "cli": cli_results,
        "warnings": sorted(set(warnings)),
    }


def main():
    os.umask(0o077)
    raw_payload = os.environ.pop(SECRET_ENV, "")
    if not raw_payload:
        fail("credential_payload_missing")
    try:
        payload = json.loads(raw_payload)
        accounts = payload.get("accounts", [])
        if not isinstance(accounts, list):
            raise ValueError
    except (TypeError, ValueError, json.JSONDecodeError):
        fail("credential_payload_invalid")
    raw_payload = None

    home = Path(os.environ.get("HOME") or str(Path.home())).expanduser().resolve()
    wecode_root = home / ".wecode"
    wecode_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    ensure_mode(wecode_root, 0o700)
    root = wecode_root / "git-auth"
    revisions = root / "revisions"
    current = root / "current"
    global_config = home / ".gitconfig"
    profile_paths = [
        home / ".profile",
        home / ".bashrc",
        home / ".bash_profile",
        home / ".zshrc",
    ]
    lock_path = wecode_root / "git-auth-sync.lock"
    lock_path.touch(mode=0o600, exist_ok=True)
    ensure_mode(lock_path, 0o600)

    with lock_path.open("r+") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("sync_in_progress")
        try:
            if not accounts:
                removed_domains, warnings = clear_managed_state(
                    home,
                    root,
                    current,
                    revisions,
                    global_config,
                    profile_paths,
                )
                emit(
                    {
                        "synced_domains": [],
                        "removed_domains": removed_domains,
                        "identity_warning_domains": [],
                        "cli": [],
                        "warnings": warnings,
                    }
                )

            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            revisions.mkdir(parents=True, exist_ok=True, mode=0o700)
            ensure_mode(root, 0o700)
            ensure_mode(revisions, 0o700)
            result = apply_accounts(
                home,
                root,
                current,
                revisions,
                global_config,
                profile_paths,
                accounts,
            )
            emit(result)
        except SystemExit:
            raise
        except Exception:
            fail("credential_apply_failed")


main()
'''.strip()


SYNC_GIT_CREDENTIALS_COMMAND = f"python3 -c {shlex.quote(GIT_CREDENTIAL_SYNC_SCRIPT)}"
