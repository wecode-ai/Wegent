import pytest

from app.services.plugin_package_parser import PluginPackageParser


@pytest.fixture
def parser() -> PluginPackageParser:
    return PluginPackageParser()


def test_parse_local_qr_connector(parser: PluginPackageParser) -> None:
    connectors = parser._parse_connectors(
        {
            "connectors": [
                {
                    "slug": "weibo-wiki",
                    "authPolicy": "on_install",
                    "localAuth": {
                        "kind": "local_qr",
                        "health": ["scripts/run-weibo-wiki.sh", "health"],
                        "start": ["scripts/run-weibo-wiki.sh", "auth", "start"],
                        "poll": [
                            "scripts/run-weibo-wiki.sh",
                            "auth",
                            "status",
                            "--wait-seconds",
                            "0",
                        ],
                        "logout": ["scripts/run-weibo-wiki.sh", "auth", "logout"],
                        "qrField": "qr_path",
                        "statusField": "status",
                        "okValues": ["ok"],
                        "pollIntervalSeconds": 2,
                    },
                }
            ]
        }
    )
    assert len(connectors) == 1
    assert connectors[0].slug == "weibo-wiki"
    assert connectors[0].authPolicy == "on_install"
    assert connectors[0].localAuth is not None
    assert connectors[0].localAuth.kind == "local_qr"
    assert connectors[0].localAuth.health[0] == "scripts/run-weibo-wiki.sh"
    assert connectors[0].localAuth.pollIntervalSeconds == 2


def test_reject_absolute_local_auth_commands(parser: PluginPackageParser) -> None:
    connectors = parser._parse_connectors(
        {
            "connectors": [
                {
                    "slug": "weibo-wiki",
                    "authPolicy": "on_install",
                    "localAuth": {
                        "kind": "local_qr",
                        "health": ["/etc/passwd"],
                        "start": ["../escape", "auth", "start"],
                        "poll": ["~/bin/run", "auth", "status"],
                    },
                }
            ]
        }
    )
    assert len(connectors) == 1
    assert connectors[0].localAuth is None


def test_oauth_connector_without_local_auth_still_works(
    parser: PluginPackageParser,
) -> None:
    connectors = parser._parse_connectors(
        {"connectors": [{"slug": "github", "authPolicy": "on_install"}]}
    )
    assert connectors[0].slug == "github"
    assert connectors[0].localAuth is None


def test_parse_browser_oauth_connector_with_managed_tool(
    parser: PluginPackageParser,
) -> None:
    connectors = parser._parse_connectors(
        {
            "connectors": [
                {
                    "slug": "gitlab-intra",
                    "authPolicy": "on_install",
                    "localAuth": {
                        "kind": "browser_oauth",
                        "health": ["scripts/local-auth.sh", "health"],
                        "start": ["scripts/local-auth.sh", "login"],
                        "logout": ["scripts/local-auth.sh", "logout"],
                        "timeoutSeconds": 300,
                        "logoutOnUninstall": False,
                        "tool": {
                            "id": "glab",
                            "source": "managed",
                            "version": "1.111.0",
                            "artifacts": {
                                "darwin-arm64": {
                                    "url": "https://gitlab.com/example/glab.tar.gz",
                                    "sha256": "a" * 64,
                                    "archive": "tar_gz",
                                    "binaryPath": "bin/glab",
                                }
                            },
                        },
                    },
                }
            ]
        }
    )

    local_auth = connectors[0].localAuth
    assert local_auth is not None
    assert local_auth.kind == "browser_oauth"
    assert local_auth.poll == []
    assert local_auth.timeoutSeconds == 300
    assert local_auth.logoutOnUninstall is False
    assert local_auth.tool is not None
    assert local_auth.tool.artifacts["darwin-arm64"].binaryPath == "bin/glab"


@pytest.mark.parametrize(
    "tool_patch",
    [
        {"version": ""},
        {
            "artifacts": {
                "darwin-arm64": {
                    "url": "http://insecure.example/glab.tar.gz",
                    "sha256": "a" * 64,
                    "archive": "tar_gz",
                    "binaryPath": "bin/glab",
                }
            }
        },
        {
            "artifacts": {
                "darwin-arm64": {
                    "url": "https://gitlab.com/example/glab.tar.gz",
                    "sha256": "invalid",
                    "archive": "tar_gz",
                    "binaryPath": "bin/glab",
                }
            }
        },
        {
            "artifacts": {
                "windows-x64": {
                    "url": "https://gitlab.com/example/glab.zip",
                    "sha256": "a" * 64,
                    "archive": "zip",
                    "binaryPath": "bin\\glab.exe",
                }
            }
        },
    ],
)
def test_reject_invalid_managed_local_auth_tool(
    parser: PluginPackageParser, tool_patch: dict[str, object]
) -> None:
    tool: dict[str, object] = {
        "id": "glab",
        "source": "managed",
        "version": "1.111.0",
        "artifacts": {
            "darwin-arm64": {
                "url": "https://gitlab.com/example/glab.tar.gz",
                "sha256": "a" * 64,
                "archive": "tar_gz",
                "binaryPath": "bin/glab",
            }
        },
    }
    tool.update(tool_patch)
    connectors = parser._parse_connectors(
        {
            "connectors": [
                {
                    "slug": "gitlab-intra",
                    "localAuth": {
                        "kind": "browser_oauth",
                        "health": ["scripts/local-auth.sh", "health"],
                        "start": ["scripts/local-auth.sh", "login"],
                        "tool": tool,
                    },
                }
            ]
        }
    )
    assert connectors[0].localAuth is None
