"""Build the DWS package and exercise an isolated official encrypted source store."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[4]
SDK = REPOSITORY / "sdk/dws-auth"


def build(output: Path, source_archive: Path | None) -> None:
    sys.path.insert(0, str(SDK))
    from package import assemble

    with tempfile.TemporaryDirectory(prefix="wegent-dws-e2e-") as directory:
        plugin = Path(directory)
        (plugin / ".codex-plugin").mkdir()
        (plugin / "scripts").mkdir()
        (plugin / ".codex-plugin/plugin.json").write_text(
            json.dumps(
                {
                    "name": "dingtalk",
                    "version": "1.0.0",
                    "description": "Isolated real DWS native business regression",
                    "connectors": [
                        {
                            "slug": "dingtalk",
                            "authPolicy": "optional",
                            "accountAuth": {
                                "protocolVersion": 1,
                                "credentialType": "oauth2",
                                "adapter": "scripts/account-auth.py",
                                "oauth2": ["refresh", "revoke"],
                                "exportMode": "exclusive",
                                "localEnvironment": {
                                    "DWS_CONFIG_DIR": {"type": "directory"},
                                    "DWS_KEYCHAIN_DIR": {"type": "directory"},
                                    "DWS_DISABLE_KEYCHAIN": {
                                        "type": "enum",
                                        "values": ["1"],
                                    },
                                },
                            },
                        }
                    ],
                }
            )
        )
        shutil.copyfile(SDK / "entry.py", plugin / "scripts/account-auth.py")
        (plugin / "scripts/cli.py").write_text(
            "import sys\nfrom pathlib import Path\n"
            "from wegent_plugin_auth import delegate_cloud_command\n"
            "result = delegate_cloud_command(Path(__file__).resolve().parents[1], "
            "'dingtalk', sys.argv[1:])\n"
            "assert result is not None\nraise SystemExit(result)\n"
        )
        subprocess.run(
            [
                sys.executable,
                str(REPOSITORY / "sdk/plugin-auth/tool.py"),
                "vendor",
                str(plugin),
            ],
            check=True,
        )
        assemble(plugin, output, source_archive)


def source_store(action: str, root: Path, source_archive: Path | None) -> None:
    # Never create or read a personal Keychain or a normal DWS configuration.
    if (
        sys.platform == "win32"
        or not root.is_relative_to(REPOSITORY / "wework/test-results/desktop-e2e")
        or root.name != "dws-source"
    ):
        raise ValueError("DWS source fixture requires its isolated POSIX E2E directory")
    for name in ("config", "keychain"):
        (root / name).mkdir(parents=True, exist_ok=True)
    helper = root / "store-helper"
    if not helper.exists():
        sys.path.insert(0, str(SDK))
        from build import VERSION, prepare_source_archive

        with tempfile.TemporaryDirectory(prefix="wegent-dws-store-build-") as temporary:
            directory = Path(temporary)
            archive = prepare_source_archive(directory, source_archive)
            with tarfile.open(archive) as upstream:
                upstream.extractall(directory, filter="data")
            upstream_root = directory / f"dingtalk-workspace-cli-{VERSION}"
            target = upstream_root / "cmd/wegent-store-fixture"
            shutil.copytree(Path(__file__).with_name("dws-store"), target)
            subprocess.run(
                [
                    "go",
                    "build",
                    "-trimpath",
                    "-o",
                    str(helper),
                    "./cmd/wegent-store-fixture",
                ],
                cwd=upstream_root,
                check=True,
            )
    environment = {
        **os.environ,
        "DWS_CONFIG_DIR": str(root / "config"),
        "DWS_KEYCHAIN_DIR": str(root / "keychain"),
        "DWS_DISABLE_KEYCHAIN": "1",
    }
    subprocess.run([str(helper), action], env=environment, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--output", type=Path, required=True)
    build_parser.add_argument("--source-archive", type=Path)
    for action in ("seed", "check"):
        store_parser = commands.add_parser(action)
        store_parser.add_argument("--source-root", type=Path, required=True)
        store_parser.add_argument("--source-archive", type=Path)
    arguments = parser.parse_args()
    if arguments.command == "build":
        build(arguments.output.resolve(), arguments.source_archive)
    else:
        source_store(
            arguments.command, arguments.source_root.resolve(), arguments.source_archive
        )


if __name__ == "__main__":
    main()
