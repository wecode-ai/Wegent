import json
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from wegent.cli import cli
from wegent.errors import EXIT_API_ERROR, CliError


def invoke_with_client(args, client, input_text=None):
    with patch("wegent.cli.WegentClient", return_value=client):
        return CliRunner().invoke(cli, args, input=input_text)


def load_error_payload(result):
    return json.loads(result.stderr or result.output)


def test_kind_get_list_outputs_json_envelope():
    client = MagicMock()
    client.list_kind.return_value = {"items": [{"metadata": {"name": "ghost-a"}}]}

    result = invoke_with_client(["kind", "get", "ghosts", "--json"], client)

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["success"] is True
    assert payload["data"]["items"][0]["metadata"]["name"] == "ghost-a"
    client.list_kind.assert_called_once_with("ghosts", "default")


def test_kind_get_json_renders_client_error_envelope():
    client = MagicMock()
    client.list_kind.side_effect = CliError(
        "api_error",
        "backend failed",
        {"status_code": 500},
        EXIT_API_ERROR,
    )

    result = invoke_with_client(["kind", "get", "ghost", "--json"], client)

    assert result.exit_code == EXIT_API_ERROR
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "api_error"
    assert payload["error"]["message"] == "backend failed"


def test_kind_get_json_without_kind_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(["kind", "get", "--json"], client)

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.list_kind.assert_not_called()
    client.get_kind.assert_not_called()


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


def test_kind_get_json_with_extra_argument_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "get", "ghost", "name", "extra", "--json"],
        client,
    )

    assert result.exit_code != 0
    error_text = result.stderr or result.output
    assert not error_text.startswith("Usage:")
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.get_kind.assert_not_called()
    client.list_kind.assert_not_called()


def test_kind_get_json_with_unknown_option_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(["kind", "get", "--unknown", "--json"], client)

    assert result.exit_code != 0
    error_text = result.stderr or result.output
    assert not error_text.startswith("Usage:")
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.get_kind.assert_not_called()
    client.list_kind.assert_not_called()


def test_kind_unknown_subcommand_json_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(["kind", "nope", "--json"], client)

    assert result.exit_code != 0
    error_text = result.stderr or result.output
    assert not error_text.startswith("Usage:")
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"


def test_kind_unknown_subcommand_without_json_uses_click_error_text():
    client = MagicMock()

    result = invoke_with_client(["kind", "nope"], client)

    assert result.exit_code != 0
    error_text = result.stderr or result.output
    assert error_text.startswith("Usage:")
    assert "No such command" in error_text


def test_top_level_get_json_is_not_preserved_and_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(["get", "ghosts", "--json"], client)

    assert result.exit_code != 0
    error_text = result.stderr or result.output
    assert not error_text.startswith("Usage:")
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.list_kind.assert_not_called()
    client.get_kind.assert_not_called()


def test_kind_describe_is_alias_for_named_get():
    client = MagicMock()
    client.get_kind.return_value = {"kind": "Team", "metadata": {"name": "agent"}}

    result = invoke_with_client(["kind", "describe", "team", "agent", "--json"], client)

    assert result.exit_code == 0
    client.get_kind.assert_called_once_with("team", "default", "agent")


def test_kind_describe_json_without_name_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(["kind", "describe", "ghost", "--json"], client)

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.get_kind.assert_not_called()


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


def test_kind_apply_json_without_source_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(["kind", "apply", "--json"], client)

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_rejects_conflicting_sources(tmp_path):
    input_file = tmp_path / "ghost.yaml"
    input_file.write_text("kind: Ghost\nmetadata:\n  name: g\n")
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--file", str(input_file), "--input", "-", "--json"],
        client,
        input_text='{"kind": "Team", "metadata": {"name": "t"}}',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.apply_kinds.assert_not_called()


def test_kind_apply_reads_multi_document_yaml(tmp_path):
    input_file = tmp_path / "resources.yaml"
    input_file.write_text(
        "kind: Ghost\nmetadata:\n  name: g\n---\n"
        "kind: Team\nmetadata:\n  name: agent\n"
    )
    client = MagicMock()
    client.apply_kinds.return_value = {"success": True, "results": []}

    result = invoke_with_client(
        ["kind", "apply", "--file", str(input_file), "--json"],
        client,
    )

    assert result.exit_code == 0
    client.apply_kinds.assert_called_once_with(
        "default",
        [
            {"kind": "Ghost", "metadata": {"name": "g"}},
            {"kind": "Team", "metadata": {"name": "agent"}},
        ],
    )


def test_kind_apply_json_backend_batch_failure_outputs_error_envelope():
    client = MagicMock()
    client.apply_kinds.return_value = {
        "success": False,
        "message": "Applied 0/1 resources",
        "results": [{"success": False, "message": "missing metadata"}],
    }

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='{"kind": "Ghost", "metadata": {"name": "g"}}',
    )

    assert result.exit_code == EXIT_API_ERROR
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "batch_operation_failed"
    assert payload["error"]["message"] == "Applied 0/1 resources"
    assert payload["error"]["details"]["results"] == [
        {"success": False, "message": "missing metadata"}
    ]


def test_kind_apply_json_invalid_structured_input_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text="{unclosed: [",
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_comment_only_input_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text="# comment only\n",
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    assert (
        payload["error"]["message"]
        == "Kind input must include at least one resource object"
    )
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_empty_input_outputs_invalid_input():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text="",
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    assert (
        payload["error"]["message"]
        == "Kind input must include at least one resource object"
    )
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_separator_only_input_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text="---\n---\n",
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    assert (
        payload["error"]["message"]
        == "Kind input must include at least one resource object"
    )
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_rejects_scalar_resource_entries():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='["bad"]',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    assert payload["error"]["message"] == "Kind resource entries must be objects"
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_rejects_missing_kind():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='{"metadata": {"name": "g"}}',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_rejects_unsupported_skill_kind():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='{"kind": "Skill", "metadata": {"name": "s"}}',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_rejects_missing_metadata():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='{"kind": "Ghost"}',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_rejects_non_dict_metadata():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='{"kind": "Ghost", "metadata": "bad"}',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    client.apply_kinds.assert_not_called()


def test_kind_apply_json_rejects_blank_metadata_name():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "apply", "--input", "-", "--json"],
        client,
        input_text='{"kind": "Ghost", "metadata": {"name": " "}}',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    client.apply_kinds.assert_not_called()


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


def test_kind_delete_json_backend_batch_failure_outputs_error_envelope():
    client = MagicMock()
    client.delete_kinds.return_value = {
        "success": False,
        "message": "Deleted 0/1 resources",
        "results": [{"success": False, "message": "not found"}],
    }

    result = invoke_with_client(
        ["kind", "delete", "--input", "-", "--json"],
        client,
        input_text='{"kind": "Ghost", "metadata": {"name": "g"}}',
    )

    assert result.exit_code == EXIT_API_ERROR
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "batch_operation_failed"
    assert payload["error"]["message"] == "Deleted 0/1 resources"
    assert payload["error"]["details"]["results"] == [
        {"success": False, "message": "not found"}
    ]


def test_kind_delete_json_rejects_name_and_input_conflict():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "delete", "ghost", "g", "--input", "-", "--json"],
        client,
        input_text='[{"kind": "Ghost", "metadata": {"name": "g"}}]',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.delete_kind.assert_not_called()
    client.delete_kinds.assert_not_called()


def test_kind_delete_json_without_name_outputs_error_envelope():
    client = MagicMock()

    result = invoke_with_client(["kind", "delete", "ghost", "--json"], client)

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_arguments"
    client.delete_kind.assert_not_called()
    client.delete_kinds.assert_not_called()


def test_kind_delete_json_rejects_scalar_resource_entries():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "delete", "--input", "-", "--json"],
        client,
        input_text="[1]",
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    assert payload["error"]["message"] == "Kind resource entries must be objects"
    client.delete_kinds.assert_not_called()
    client.delete_kind.assert_not_called()


def test_kind_delete_json_whitespace_only_input_outputs_invalid_input():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "delete", "--input", "-", "--json"],
        client,
        input_text="  \n\t\n",
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    assert (
        payload["error"]["message"]
        == "Kind input must include at least one resource object"
    )
    client.delete_kinds.assert_not_called()
    client.delete_kind.assert_not_called()


def test_kind_delete_json_rejects_missing_metadata_name():
    client = MagicMock()

    result = invoke_with_client(
        ["kind", "delete", "--input", "-", "--json"],
        client,
        input_text='{"kind": "Ghost", "metadata": {}}',
    )

    assert result.exit_code != 0
    payload = load_error_payload(result)
    assert payload["success"] is False
    assert payload["error"]["code"] == "invalid_input"
    client.delete_kinds.assert_not_called()
    client.delete_kind.assert_not_called()


def test_kind_delete_reads_multi_document_yaml_from_stdin():
    client = MagicMock()
    client.delete_kinds.return_value = {"success": True, "results": []}

    result = invoke_with_client(
        ["kind", "delete", "--input", "-", "--json"],
        client,
        input_text=(
            "kind: Ghost\nmetadata:\n  name: g\n---\n"
            "kind: Team\nmetadata:\n  name: agent\n"
        ),
    )

    assert result.exit_code == 0
    client.delete_kinds.assert_called_once_with(
        "default",
        [
            {"kind": "Ghost", "metadata": {"name": "g"}},
            {"kind": "Team", "metadata": {"name": "agent"}},
        ],
    )
