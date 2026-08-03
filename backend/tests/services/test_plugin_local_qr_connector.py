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
