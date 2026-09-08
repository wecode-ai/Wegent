#!/usr/bin/env python3
"""Verify packaged DWS binaries and the real private adapter entry offline."""

import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


def verify_artifacts(plugin: Path, targets: tuple[str, ...]) -> None:
    for target in targets:
        executable = plugin / "scripts/native" / target.replace("/", "-")
        executable /= (
            "dws-account-auth.exe"
            if target.startswith("windows/")
            else "dws-account-auth"
        )
        metadata = json.loads(
            executable.with_name(executable.name + ".json").read_text()
        )
        if (
            metadata.get("target") != target
            or type(metadata.get("nativeProtocolVersion")) is not int
            or metadata.get("nativeProtocolVersion") != 1
            or metadata.get("binarySha256")
            != hashlib.sha256(executable.read_bytes()).hexdigest()
        ):
            raise ValueError("DWS artifact provenance mismatch")
        for suffix in ("LICENSE", "NOTICE"):
            if not executable.with_name(executable.name + "." + suffix).is_file():
                raise ValueError("DWS artifact license is missing")


def invoke(
    plugin: Path, home: Path, credential: dict, connector: str
) -> subprocess.CompletedProcess:
    nonce = os.urandom(32)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}
    }
    environment.update(
        HOME=str(home),
        USERPROFILE=str(home),
        DWS_CONFIG_DIR=str(home / ".dws"),
        PYTHONDONTWRITEBYTECODE="1",
    )
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        environment["WEGENT_PLUGIN_AUTH_PORT"] = str(listener.getsockname()[1])
        process = subprocess.Popen(
            [
                sys.executable,
                str(plugin / "scripts/account-auth.py"),
                "run",
                "account-status",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        try:
            process.stdin.write(nonce)
            process.stdin.close()
            process.stdin = None
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(15)
                received = b""
                while len(received) < len(nonce):
                    chunk = connection.recv(len(nonce) - len(received))
                    if not chunk:
                        raise ValueError(
                            "DWS private channel closed before authentication"
                        )
                    received += chunk
                if received != nonce:
                    raise ValueError("DWS private channel authentication failed")
                payload = json.dumps(
                    {
                        "protocolVersion": 1,
                        "connectorSlug": connector,
                        "credentialType": "oauth2",
                        "credential": credential,
                    }
                ).encode()
                connection.sendall(struct.pack(">I", len(payload)) + payload)
            stdout, stderr = process.communicate(timeout=15)
            return subprocess.CompletedProcess(
                process.args, process.returncode, stdout, stderr
            )
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


def verify_native_entry(plugin: Path) -> None:
    credential = {
        "access_token": "synthetic-package-access-token",
        "corp_id": "synthetic-corp",
        "user_id": "synthetic-user",
        "source": "mcp",
        "client_id": "synthetic-client",
        "expires_at": 253402300798,
    }
    with tempfile.TemporaryDirectory(prefix="wegent-dws-verify-") as temporary:
        home = Path(temporary) / "home"
        home.mkdir()
        success = invoke(plugin, home, credential, "dingtalk")
        if success.returncode != 0 or json.loads(success.stdout) != {
            "authenticated": True,
            "accountId": "synthetic-corp:synthetic-user",
        }:
            raise ValueError("DWS packaged adapter health failed")
        rejected = [
            invoke(
                plugin,
                home,
                {**credential, "refresh_token": "synthetic-refresh-token"},
                "dingtalk",
            ),
            invoke(plugin, home, credential, "wrong-connector"),
        ]
        if any(result.returncode == 0 for result in rejected):
            raise ValueError(
                "DWS packaged adapter accepted an invalid business credential"
            )
        if any(
            token in result.stdout + result.stderr
            for token in (b"synthetic-package-access-token", b"synthetic-refresh-token")
            for result in [success, *rejected]
        ):
            raise ValueError("DWS packaged adapter exposed a credential")
        # Docker Desktop's Rosetta loader creates two empty cache directories.
        # No file, link, provider directory or other state is permitted.
        for path in home.rglob("*"):
            if (
                path.relative_to(home).as_posix() not in {".cache", ".cache/rosetta"}
                or path.is_symlink()
                or not path.is_dir()
            ):
                raise ValueError(
                    "DWS packaged business adapter wrote local account state"
                )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", required=True, type=Path)
    arguments = parser.parse_args()
    verify_native_entry(arguments.plugin.resolve())
    print(
        json.dumps(
            {
                "nativeEntry": True,
                "invalidCredentialsRejected": True,
                "localStateUnchanged": True,
            }
        )
    )


if __name__ == "__main__":
    main()
