import json
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from wegent.cli import cli


def invoke_with_client(args, client, input_text=None):
    with patch("wegent.cli.WegentClient", return_value=client):
        return CliRunner().invoke(cli, args, input=input_text)


def test_kind_get_list_outputs_json_envelope():
    client = MagicMock()
    client.list_kind.return_value = {"items": [{"metadata": {"name": "ghost-a"}}]}

    result = invoke_with_client(["kind", "get", "ghosts", "--json"], client)

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert payload["data"]["items"][0]["metadata"]["name"] == "ghost-a"
    client.list_kind.assert_called_once_with("ghosts", "default")


def test_kind_get_named_resource_outputs_resource():
    client = MagicMock()
    client.get_kind.return_value = {"kind": "Team", "metadata": {"name": "agent"}}

    result = invoke_with_client(
        ["kind", "get", "team", "agent", "--namespace", "default", "--json"],
        client,
    )

    assert result.exit_code == 0
    assert json.loads(result.output)["data"]["kind"] == "Team"
    client.get_kind.assert_called_once_with("team", "default", "agent")


def test_kind_describe_is_alias_for_named_get():
    client = MagicMock()
    client.get_kind.return_value = {"kind": "Team", "metadata": {"name": "agent"}}

    result = invoke_with_client(["kind", "describe", "team", "agent", "--json"], client)

    assert result.exit_code == 0
    client.get_kind.assert_called_once_with("team", "default", "agent")


def test_kind_apply_reads_stdin_json():
    client = MagicMock()
    client.apply_kinds.return_value = {"success": True, "results": []}

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='[{"kind": "Ghost", "metadata": {"name": "g"}}]',
    )

    assert result.exit_code == 0
    client.apply_kinds.assert_called_once_with(
        "default", [{"kind": "Ghost", "metadata": {"name": "g"}}]
    )


def test_kind_apply_reads_file(tmp_path):
    input_file = tmp_path / "ghost.yaml"
    input_file.write_text("kind: Ghost\nmetadata:\n  name: g\n")
    client = MagicMock()
    client.apply_kinds.return_value = {"success": True, "results": []}

    result = invoke_with_client(
        ["kind", "apply", "--file", str(input_file), "--namespace", "dev", "--json"],
        client,
    )

    assert result.exit_code == 0
    client.apply_kinds.assert_called_once_with(
        "dev", [{"kind": "Ghost", "metadata": {"name": "g"}}]
    )


def test_kind_delete_named_resource():
    client = MagicMock()
    client.delete_kind.return_value = {"message": "deleted"}

    result = invoke_with_client(["kind", "delete", "ghost", "g", "--json"], client)

    assert result.exit_code == 0
    client.delete_kind.assert_called_once_with("ghost", "default", "g")


def test_kind_delete_reads_stdin_json():
    client = MagicMock()
    client.delete_kinds.return_value = {"success": True, "results": []}

    result = invoke_with_client(
        ["kind", "delete", "--input", "-", "--namespace", "dev", "--json"],
        client,
        input_text='[{"kind": "Ghost", "metadata": {"name": "g"}}]',
    )

    assert result.exit_code == 0
    client.delete_kinds.assert_called_once_with(
        "dev", [{"kind": "Ghost", "metadata": {"name": "g"}}]
    )
