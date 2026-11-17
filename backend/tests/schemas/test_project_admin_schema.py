# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project administration input boundaries independent of a desktop client."""

from copy import deepcopy

import pytest
from pydantic import ValidationError

from app.mcp_server.tool_catalog import (
    ProjectAdminSpaceUpdate,
    ProjectBoardViewsUpdate,
    ProjectTagsUpdate,
)
from app.schemas.cloud_project import CloudProjectResponse, CloudProjectUpdate
from app.schemas.project_admin import ProjectAdminWriteResult
from app.schemas.tagging import normalize_tags


def _view() -> dict:
    return {
        "id": "delivery",
        "name": "Delivery",
        "columns": [
            {"id": "todo", "type": "status", "value": "pending"},
            {"id": "design", "type": "tag", "value": "design"},
            {"id": "other", "type": "unmatched", "value": "Other"},
        ],
        "filter": {"tags": ["design"], "match": "all"},
    }


def test_board_view_update_preserves_typed_column_order() -> None:
    values = CloudProjectUpdate(version=4, board_views={"views": [_view()]})

    assert values.board_views is not None
    assert [column.type for column in values.board_views.views[0].columns] == [
        "status",
        "tag",
        "unmatched",
    ]
    assert values.board_views.views[0].columns[0].value == "pending"


@pytest.mark.parametrize("location", ["envelope", "view", "column", "filter"])
def test_mcp_views_reject_unknown_fields_without_restricting_page_extensions(
    location: str,
) -> None:
    config = {"views": [_view()]}
    view = config["views"][0]
    targets = {
        "envelope": config,
        "view": view,
        "column": view["columns"][0],
        "filter": view["filter"],
    }
    targets[location]["undeclared"] = "unsupported"
    assert CloudProjectUpdate(version=1, board_views=config).board_views is not None

    with pytest.raises(ValidationError) as failure:
        ProjectBoardViewsUpdate(version=1, board_views=config)

    assert failure.value.errors()[0]["type"] == "extra_forbidden"


def test_mcp_schema_explicitly_declares_filter_and_nested_field_boundaries() -> None:
    schema = ProjectBoardViewsUpdate.model_json_schema()
    for name in (
        "ProjectAdminBoardViews",
        "ProjectAdminBoardView",
        "ProjectAdminBoardColumn",
        "ProjectAdminBoardFilter",
    ):
        assert schema["$defs"][name]["additionalProperties"] is False
    assert (
        schema["$defs"]["ProjectAdminBoardFilter"]["properties"]["needs_my_input"][
            "type"
        ]
        == "boolean"
    )
    config = {"views": [_view()]}
    config["views"][0]["filter"]["needs_my_input"] = True
    values = ProjectBoardViewsUpdate(version=1, board_views=config)
    assert values.board_views.views[0].filter.needs_my_input is True


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("columns", [], "at least 1 item"),
        ("sorts", {"todo": ["sql"]}, "Input should be"),
        ("sorts", {"todo": ["created-desc", "created-asc"]}, "unique"),
        ("filter", {"match": "sql"}, "Input should be"),
        ("name", "   ", "must not be blank"),
    ],
)
def test_board_views_reject_invalid_configuration(
    field: str, value: object, message: str
) -> None:
    view = _view()
    view[field] = value

    with pytest.raises(ValidationError, match=message):
        CloudProjectUpdate(version=1, board_views={"views": [view]})


def test_duplicate_columns_and_targets_are_rejected() -> None:
    view = _view()
    view["columns"].append(deepcopy(view["columns"][0]))
    with pytest.raises(
        ValidationError, match="column ids and bindings must be unique"
    ) as failure:
        CloudProjectUpdate(version=1, board_views={"views": [view]})
    assert failure.value.errors()[0]["loc"] == ("board_views", "views", 0)

    view["columns"][-1]["id"] = "duplicate-target"
    with pytest.raises(ValidationError, match="column ids and bindings must be unique"):
        CloudProjectUpdate(version=1, board_views={"views": [view]})


def test_view_collection_requires_unique_ids_and_one_default() -> None:
    view = _view()
    with pytest.raises(ValidationError, match="board view ids must be unique"):
        CloudProjectUpdate(version=1, board_views={"views": [view, deepcopy(view)]})

    other = {**view, "id": "second"}
    with pytest.raises(ValidationError, match="existing view"):
        CloudProjectUpdate(
            version=1,
            board_views={"default_view_id": "missing", "views": [view, other]},
        )


@pytest.mark.parametrize(
    "column",
    [
        {"id": "bad", "type": "status"},
        {"id": "bad", "type": "tag", "tag": "  "},
        {"id": "bad", "type": "unmatched", "value": "  "},
        {"id": "bad", "type": "priority", "priority": "high"},
    ],
)
def test_board_column_discriminator_rejects_missing_or_foreign_fields(
    column: dict,
) -> None:
    view = {**_view(), "columns": [column]}

    with pytest.raises(ValidationError):
        CloudProjectUpdate(version=1, board_views={"views": [view]})


@pytest.mark.parametrize(
    "model", [CloudProjectUpdate, ProjectTagsUpdate, ProjectAdminSpaceUpdate]
)
@pytest.mark.parametrize("tags", [["x" * 33], [f"tag-{index}" for index in range(21)]])
def test_project_tag_limits_apply_after_shared_normalization(
    model: type, tags: object
) -> None:
    with pytest.raises(ValidationError):
        model(version=1, tags=tags)


@pytest.mark.parametrize(
    "model", [CloudProjectUpdate, ProjectTagsUpdate, ProjectAdminSpaceUpdate]
)
@pytest.mark.parametrize("tags", ["design", {"name": "design"}])
def test_project_tag_writes_require_an_array(model: type, tags: object) -> None:
    with pytest.raises(ValidationError) as failure:
        model(version=1, tags=tags)

    assert failure.value.errors()[0]["loc"] == ("tags",)


def test_tag_reads_still_tolerate_malformed_legacy_metadata() -> None:
    assert normalize_tags("design") == []
    assert normalize_tags({"name": "design"}) == []


@pytest.mark.parametrize(
    "model", [CloudProjectUpdate, ProjectTagsUpdate, ProjectAdminSpaceUpdate]
)
@pytest.mark.parametrize(
    ("tags", "expected"),
    [(["  "], []), ([123], ["123"]), ([" tag ", "tag", ""], ["tag"])],
)
def test_project_tag_models_share_main_normalization(
    model: type, tags: list, expected: list[str]
) -> None:
    assert model(version=1, tags=tags).tags == expected


def test_tag_change_and_operation_controls_are_explicit() -> None:
    values = CloudProjectUpdate(
        version=2,
        operation_id=" operation-1 ",
        dry_run=True,
        tag_change={"source": "old", "target": "new"},
    )
    assert values.operation_id == "operation-1"
    assert values.tag_change is not None
    assert values.tag_change.source == "old"
    assert values.tag_change.target == "new"

    with pytest.raises(ValidationError, match="cannot be supplied together"):
        CloudProjectUpdate(
            version=1, tags=[], tag_change={"source": "old", "target": None}
        )
    with pytest.raises(ValidationError, match="cannot be empty"):
        CloudProjectUpdate(version=1, operation_id="   ")
    with pytest.raises(ValidationError, match="Extra inputs"):
        CloudProjectUpdate(version=1, hidden_provider_field="unsupported")


def test_operation_aliases_cannot_name_different_requests() -> None:
    with pytest.raises(ValidationError, match="must match"):
        CloudProjectUpdate(
            version=1, operation_id="operation-1", idempotency_key="operation-2"
        )

    values = CloudProjectUpdate(
        version=1, operation_id="operation-1", idempotency_key="operation-1"
    )
    assert values.operation_id == values.idempotency_key


def test_admin_result_schema_exposes_audit_and_version() -> None:
    schema = ProjectAdminWriteResult.model_json_schema()
    expected = {
        "projectVersion",
        "revision",
        "before",
        "after",
        "diff",
        "actor",
        "operationId",
        "appliedAt",
        "auditId",
        "dryRun",
    }

    assert expected <= schema["properties"].keys()
    assert schema["additionalProperties"] is False
    response_fields = CloudProjectResponse.model_fields
    assert {"board_views", "collaboration_policy", "project_admin_result"} <= (
        response_fields.keys()
    )
    assert "project_admin_operations" not in response_fields


def test_board_views_schema_declares_typed_columns() -> None:
    schema = CloudProjectUpdate.model_json_schema()
    columns = schema["$defs"]["BoardView"]["properties"]["columns"]

    assert columns["minItems"] == 1
    column = schema["$defs"]["BoardViewColumn"]
    assert set(column["properties"]["type"]["enum"]) == {"status", "tag", "unmatched"}
    assert "value" in column["required"]
