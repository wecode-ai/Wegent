# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project administration schema, authorization and desktop-free tool contracts."""

import inspect
import uuid
from copy import deepcopy
from typing import get_type_hints

import pytest
from fastapi import HTTPException
from jsonschema import validate
from sqlalchemy.orm import Session

from app.core.config import settings
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.context import MCPRequestContext, reset_mcp_context, set_mcp_context
from app.mcp_server.project_admin_server import ProjectAdminMCP
from app.mcp_server.tool_catalog import (
    PROJECT_ADMIN_OPERATIONS,
    ProjectAdminSpaceUpdate,
    build_project_admin_catalog,
)
from app.mcp_server.tool_registry import _register_tool
from app.mcp_server.tools import wework_project_admin, wework_space
from app.models.cloud_project import CloudProject
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_admin import ProjectAdminReadResult, ProjectAdminWriteResult
from tests.utils.collaboration import authorize_project


class _SessionContext:
    def __init__(self, db: Session) -> None:
        self.db = db

    def __enter__(self) -> Session:
        return self.db

    def __exit__(self, exc_type: object, *_args: object) -> None:
        if exc_type is not None:
            self.db.rollback()


def _token(user: User) -> MCPAuthInfo:
    return MCPAuthInfo(user_id=user.id, user_name=user.user_name, auth_type="user")


@pytest.fixture
def managed_project(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> CloudProject:
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key=f"ADM{uuid.uuid4().hex[:6].upper()}",
        name="Project administration",
        description="Original policy",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{uuid.uuid4()}",
        metadata_json={"task_provider": "local", "tags": ["design"]},
    )
    authorize_project(test_db, project)
    test_db.commit()
    test_db.refresh(project)
    monkeypatch.setattr(
        wework_project_admin, "SessionLocal", lambda: _SessionContext(test_db)
    )
    monkeypatch.setattr(settings, "WEWORK_PROJECT_ADMIN_TOOLS_V1", True)
    return project


@pytest.mark.asyncio
async def test_catalog_input_schemas_match_registered_mcp_tools() -> None:
    server = ProjectAdminMCP("project-admin-contract")
    catalog = build_project_admin_catalog(BaseRole.Maintainer, 7, 3, True)
    descriptors = {entry["toolName"]: entry for entry in catalog["operations"]}

    for operation in PROJECT_ADMIN_OPERATIONS:
        function = getattr(wework_project_admin, operation.tool_name)
        _register_tool(server, function._mcp_tool_info, "wework_space")
        parameters = inspect.signature(function).parameters
        assert "token_info" not in operation.input_schema()["properties"]
        if operation.request_type:
            assert get_type_hints(function)["request"] is operation.request_type
            assert parameters["request"].default is inspect.Parameter.empty

    for tool in await server.list_tools():
        schema = descriptors[tool.name]["inputSchema"]
        assert tool.inputSchema == schema
        assert tool.outputSchema == descriptors[tool.name]["outputSchema"]


def test_catalog_describes_all_domains_with_callable_typed_capabilities() -> None:
    catalog = build_project_admin_catalog(BaseRole.Maintainer, 5, 2, True)
    operations = {entry["name"]: entry for entry in catalog["operations"]}
    assert {
        "project.get",
        "project.tags.replace",
        "project.tag.change",
        "project.boardViews.update",
        "project.strategy.update",
        "project.statuses.update",
        "project.workflow.update",
        "project.automation.update",
        "project.members.get",
        "project.members.update",
        "project.assistantRoster.get",
        "project.assistantRoster.update",
    } <= operations.keys()
    assert catalog["unavailableCapabilities"] == []
    for descriptor in catalog["operations"]:
        assert {
            "name",
            "description",
            "inputSchema",
            "outputSchema",
            "permission",
            "supportsDryRun",
            "availability",
        } <= descriptor.keys()
    wrapper = catalog["updateSpaceInputSchema"]
    assert wrapper["$defs"]["ProjectAdminSpaceUpdate"]["properties"] == (
        ProjectAdminSpaceUpdate.model_json_schema()["properties"]
    )
    assert (
        "provider_config"
        not in wrapper["$defs"]["ProjectAdminSpaceUpdate"]["properties"]
    )


@pytest.mark.parametrize("role", [BaseRole.Viewer, BaseRole.Developer])
def test_catalog_hides_unauthorized_writes(role: BaseRole) -> None:
    catalog = build_project_admin_catalog(role, 5, 2, True)
    assert [entry["name"] for entry in catalog["operations"]] == [
        "project.get",
        "project.members.get",
        "project.assistantRoster.get",
    ]
    hidden = catalog["unavailableCapabilities"]
    assert (
        next(entry for entry in hidden if entry["name"] == "project.tags.replace")[
            "availability"
        ]["reason_code"]
        == "permission_denied"
    )


def test_feature_disabled_hides_and_denies_writes(
    managed_project: CloudProject, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "WEWORK_PROJECT_ADMIN_TOOLS_V1", False)
    token = _token(test_user)
    catalog = wework_project_admin.get_project_admin_capabilities(
        token, str(managed_project.id)
    )
    assert [entry["name"] for entry in catalog["operations"]] == [
        "project.get",
        "project.members.get",
        "project.assistantRoster.get",
    ]

    result = wework_project_admin.update_project_tags(
        token, {"version": managed_project.version, "tags": []}, str(managed_project.id)
    )
    assert result["error"]["reason_code"] == "feature_disabled"
    read = wework_project_admin.get_project_config(token, str(managed_project.id))
    assert read["configuration"]["tags"] == ["design"]


@pytest.mark.parametrize("transport", ["dedicated", "generic"])
@pytest.mark.parametrize("tags", ["design", {"name": "design"}])
def test_malformed_tag_write_keeps_configuration_unchanged(
    managed_project: CloudProject,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    transport: str,
    tags: object,
) -> None:
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    before = deepcopy(managed_project.metadata_json)
    version = managed_project.version
    write = (
        wework_project_admin.update_project_tags
        if transport == "dedicated"
        else wework_space.update_space
    )

    result = write(
        _token(test_user), {"version": version, "tags": tags}, str(managed_project.id)
    )

    assert result["error"]["reason_code"] == "invalid_config"
    test_db.refresh(managed_project)
    assert managed_project.metadata_json == before
    assert managed_project.version == version


@pytest.mark.parametrize(
    "field",
    [
        "tag_change",
        "board_config",
        "board_views",
        "collaboration_policy",
        "workflow_definition",
        "ai_automation",
        "pull_request_automation",
        "member_changes",
        "assistant_roster_changes",
    ],
)
def test_disabled_generic_space_update_rejects_explicit_admin_fields(
    managed_project: CloudProject,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
) -> None:
    monkeypatch.setattr(settings, "WEWORK_PROJECT_ADMIN_TOOLS_V1", False)
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    before = deepcopy(managed_project.metadata_json)
    version = managed_project.version

    result = wework_space.update_space(
        _token(test_user),
        {"version": version, "name": "Must stay unchanged", field: None},
        str(managed_project.id),
    )

    assert result["error"]["reason_code"] == "feature_disabled"
    test_db.refresh(managed_project)
    assert managed_project.metadata_json == before
    assert managed_project.version == version
    assert managed_project.name == "Project administration"


def test_disabled_generic_space_update_preserves_legacy_writes_and_controls(
    managed_project: CloudProject,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "WEWORK_PROJECT_ADMIN_TOOLS_V1", False)
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    token = _token(test_user)
    space_id = str(managed_project.id)
    request = {
        "version": managed_project.version,
        "name": "Legacy update",
        "description": "Legacy description",
        "tags": ["design", "legacy"],
        "operation_id": "legacy-update",
        "idempotency_key": "legacy-update",
    }

    written = wework_space.update_space(token, request, space_id)

    assert "error" not in written
    assert written["name"] == "Legacy update"
    assert written["description"] == "Legacy description"
    assert written["tags"] == ["design", "legacy"]
    assert wework_space.update_space(token, request, space_id) == written
    test_db.refresh(managed_project)
    before = deepcopy(managed_project.metadata_json)
    version = managed_project.version
    preview = wework_space.update_space(
        token,
        {
            "version": version,
            "tags": ["preview"],
            "operation_id": "legacy-preview",
            "dry_run": True,
        },
        space_id,
    )
    assert preview["project_admin_result"]["dryRun"] is True
    test_db.refresh(managed_project)
    assert managed_project.metadata_json == before
    assert managed_project.version == version
    read = wework_project_admin.get_project_config(token, space_id)
    assert read["configuration"]["tags"] == ["design", "legacy"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        (
            "member_changes",
            [{"operation": "add", "user_id": 999, "permission_role": "Viewer"}],
        ),
        ("board_views", {"unsupported": "Rejected before configuration validation"}),
    ],
)
async def test_remote_disabled_space_admin_write_has_no_partial_mutation(
    managed_project: CloudProject,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: object,
) -> None:
    monkeypatch.setattr(settings, "WEWORK_PROJECT_ADMIN_TOOLS_V1", False)
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    before = deepcopy(managed_project.metadata_json)
    version = managed_project.version
    server = ProjectAdminMCP("project-admin-rollback")
    _register_tool(server, wework_space.update_space._mcp_tool_info, "wework_space")
    context = set_mcp_context(
        MCPRequestContext(
            token_info=_token(test_user),
            tool_name="update_space",
            server_name="wework_space",
        )
    )
    try:
        result = await server.call_tool(
            "update_space",
            {
                "space_id": str(managed_project.id),
                "project": {"version": version, field: value},
            },
        )
    finally:
        reset_mcp_context(context)

    assert result.isError is True
    assert result.structuredContent["error"]["reason_code"] == "feature_disabled"
    test_db.refresh(managed_project)
    assert managed_project.metadata_json == before
    assert managed_project.version == version


def test_typed_tools_apply_and_read_configuration_without_desktop(
    managed_project: CloudProject, test_user: User
) -> None:
    token = _token(test_user)
    space_id = str(managed_project.id)
    initial = wework_project_admin.get_project_config(token, space_id)
    ProjectAdminReadResult.model_validate(initial)
    version = initial["projectVersion"]
    request = {
        "version": version,
        "tags": ["design", "review"],
        "operation_id": "tags-1",
    }

    preview = wework_project_admin.update_project_tags(
        token, {**request, "dry_run": True}, space_id
    )
    ProjectAdminWriteResult.model_validate(preview)
    assert preview["dryRun"] is True
    assert preview["auditId"] is None
    assert wework_project_admin.get_project_config(token, space_id) == initial

    tags = wework_project_admin.update_project_tags(token, request, space_id)
    ProjectAdminWriteResult.model_validate(tags)
    assert tags["projectVersion"] == version + 1
    assert tags["auditId"]
    assert wework_project_admin.update_project_tags(token, request, space_id) == tags

    views = [
        {
            "id": "review",
            "name": "Review",
            "columns": [{"id": "review", "type": "tag", "value": "review"}],
            "filter": {"tags": ["review"]},
        }
    ]
    board = wework_project_admin.update_project_board_views(
        token,
        {
            "version": tags["projectVersion"],
            "board_views": {"schema_version": 1, "views": views},
        },
        space_id,
    )
    ProjectAdminWriteResult.model_validate(board)
    strategy = wework_project_admin.update_project_strategy(
        token,
        {
            "version": board["projectVersion"],
            "collaboration_policy": {"content": "Review every change."},
        },
        space_id,
    )
    ProjectAdminWriteResult.model_validate(strategy)
    assert strategy["effectScope"] == "future_issues"
    assert strategy["runningIssueSnapshotRule"] == "preserved"
    final = wework_project_admin.get_project_config(token, space_id)
    assert final["configuration"]["tags"] == ["design", "review"]
    assert final["configuration"]["board_views"]["views"][0]["id"] == "review"
    assert (
        final["configuration"]["collaboration_policy"]["content"]
        == "Review every change."
    )


def test_roster_tools_share_version_audit_idempotency_and_safe_readback(
    managed_project: CloudProject, test_user: User, test_db: Session
) -> None:
    target = User(user_name="mcp-roster-member", password_hash="unused", is_active=True)
    test_db.add(target)
    test_db.commit()
    token = _token(test_user)
    space_id = str(managed_project.id)
    request = {
        "version": managed_project.version,
        "operation_id": "roster-members",
        "member_changes": [
            {
                "operation": "add",
                "user_id": target.id,
                "permission_role": "Developer",
                "capability_description": "QA",
            }
        ],
    }

    receipt = wework_project_admin.update_project_members(token, request, space_id)
    replay = wework_project_admin.update_project_members(token, request, space_id)
    members = wework_project_admin.get_project_members(token, space_id)
    assistants = wework_project_admin.get_project_assistant_roster(token, space_id)

    ProjectAdminWriteResult.model_validate(receipt)
    assert receipt == replay
    assert receipt["auditId"]
    assert set(members["configuration"]) == {"members"}
    assert members["projectVersion"] == receipt["projectVersion"]
    member = next(
        row
        for row in members["configuration"]["members"]
        if row["user_id"] == target.id
    )
    assert member["permission_role"] == "Developer"
    assert member["capability_description"] == "QA"
    assert "email" not in member
    assert assistants["configuration"] == {"assistant_roster": []}


def test_viewer_write_is_denied_and_configuration_unchanged(
    managed_project: CloudProject, test_db: Session, test_user: User
) -> None:
    viewer = User(user_name="admin-viewer", password_hash="unused", is_active=True)
    test_db.add(viewer)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(managed_project.id),
            entity_id=str(viewer.id),
            role="Viewer",
            status="approved",
        )
    )
    test_db.commit()
    result = wework_project_admin.update_project_tags(
        _token(viewer),
        {"version": managed_project.version, "tags": []},
        str(managed_project.id),
    )
    assert result["error"]["reason_code"] == "permission_denied"
    assert result["error"]["status_code"] == 403
    read = wework_project_admin.get_project_config(
        _token(test_user), str(managed_project.id)
    )
    assert read["configuration"]["tags"] == ["design"]


def test_invalid_fields_and_duplicate_columns_return_field_errors(
    managed_project: CloudProject, test_user: User
) -> None:
    token = _token(test_user)
    result = wework_project_admin.update_project_tags(
        token,
        {"version": 1, "tags": [], "sql": "not supported"},
        str(managed_project.id),
    )
    assert result["error"]["reason_code"] == "unsupported_field"
    assert result["error"]["fields"][0]["path"] == ["sql"]
    duplicate = {"id": "same", "type": "unmatched", "value": "Other"}
    result = wework_project_admin.update_project_board_views(
        token,
        {
            "version": 1,
            "board_views": {
                "schema_version": 1,
                "views": [
                    {
                        "id": "invalid",
                        "name": "Invalid",
                        "columns": [duplicate, duplicate],
                    }
                ],
            },
        },
        str(managed_project.id),
    )
    assert result["error"]["reason_code"] == "invalid_config"
    assert result["error"]["fields"][0]["path"] == ["board_views", "views", 0]


def test_mcp_rejects_undeclared_nested_view_fields_without_writing(
    managed_project: CloudProject, test_user: User
) -> None:
    before = deepcopy(managed_project.metadata_json)
    result = wework_project_admin.update_project_board_views(
        _token(test_user),
        {
            "version": managed_project.version,
            "board_views": {
                "views": [
                    {
                        "id": "review",
                        "name": "Review",
                        "columns": [
                            {
                                "id": "other",
                                "type": "unmatched",
                                "value": "Other",
                                "sql": "unsupported",
                            }
                        ],
                    }
                ]
            },
        },
        str(managed_project.id),
    )

    assert result["error"]["reason_code"] == "unsupported_field"
    assert result["error"]["fields"][0]["path"] == [
        "board_views",
        "views",
        0,
        "columns",
        0,
        "sql",
    ]
    assert managed_project.metadata_json == before
    assert managed_project.version == 1


def test_task_token_cannot_target_another_project(
    managed_project: CloudProject, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="task", task_id=1
    )
    monkeypatch.setattr(
        wework_space,
        "_task_labels",
        lambda *_args: {
            "source": "project_automation",
            "weworkSpaceProjectId": str(managed_project.id),
            "weworkSpaceTaskId": "BOARD-1",
        },
    )
    result = wework_project_admin.get_project_config(
        token, str(int(managed_project.id) + 1)
    )
    assert result["error"]["reason_code"] == "invalid_config"
    assert "does not match" in result["error"]["message"]


def test_error_transport_preserves_reference_conflicts() -> None:
    error = wework_project_admin.project_admin_error(
        HTTPException(
            409,
            {
                "reason_code": "partial_reference_conflict",
                "message": "Only column would be removed",
                "fields": [
                    {"path": "board_views.0.columns", "message": "Keep a column"}
                ],
            },
        )
    )
    assert error["error"]["reason_code"] == "partial_reference_conflict"
    assert error["error"]["fields"][0]["path"] == "board_views.0.columns"


@pytest.mark.asyncio
async def test_remote_protocol_returns_structured_success_and_validation_errors(
    managed_project: CloudProject, test_user: User
) -> None:
    server = ProjectAdminMCP("project-admin-protocol")
    for operation in PROJECT_ADMIN_OPERATIONS:
        function = getattr(wework_project_admin, operation.tool_name)
        _register_tool(server, function._mcp_tool_info, "wework_space")
    _register_tool(server, wework_space.update_space._mcp_tool_info, "wework_space")
    schemas = {tool.name: tool.outputSchema for tool in await server.list_tools()}
    context = set_mcp_context(
        MCPRequestContext(
            token_info=_token(test_user),
            tool_name="get_project_config",
            server_name="wework_space",
        )
    )
    try:
        result = await server.call_tool(
            "get_project_config", {"space_id": str(managed_project.id)}
        )
        assert result.isError is False
        validate(result.structuredContent, schemas["get_project_config"])
        assert result.structuredContent["configuration"]["tags"] == ["design"]

        result = await server.call_tool(
            "update_project_tags",
            {
                "space_id": str(managed_project.id),
                "request": {"version": 1, "tags": [], "unsupported": True},
            },
        )
        assert result.isError is True
        validate(result.structuredContent, schemas["update_project_tags"])
        assert result.structuredContent["error"]["reason_code"] == "unsupported_field"
        assert result.structuredContent["error"]["fields"][0]["path"] == [
            "request",
            "unsupported",
        ]

        result = await server.call_tool(
            "update_space",
            {
                "space_id": str(managed_project.id),
                "project": {
                    "version": 1,
                    "board_views": {
                        "schema_version": 1,
                        "views": [
                            {
                                "id": "empty",
                                "name": "Empty",
                                "columns": [],
                            }
                        ],
                    },
                },
            },
        )
        assert result.isError is True
        validate(result.structuredContent, schemas["update_space"])
        assert result.structuredContent["error"]["reason_code"] == "invalid_config"
        assert result.structuredContent["error"]["fields"][0]["path"] == [
            "project",
            "board_views",
            "views",
            0,
            "columns",
        ]
    finally:
        reset_mcp_context(context)


@pytest.mark.asyncio
async def test_remote_protocol_conflict_keeps_reason_and_has_no_partial_write(
    managed_project: CloudProject, test_user: User
) -> None:
    server = ProjectAdminMCP("project-admin-conflict")
    _register_tool(
        server, wework_project_admin.update_project_tags._mcp_tool_info, "wework_space"
    )
    context = set_mcp_context(
        MCPRequestContext(
            token_info=_token(test_user),
            tool_name="update_project_tags",
            server_name="wework_space",
        )
    )
    try:
        result = await server.call_tool(
            "update_project_tags",
            {
                "space_id": str(managed_project.id),
                "request": {"version": managed_project.version + 1, "tags": []},
            },
        )
        assert result.isError is True
        assert result.structuredContent["error"]["reason_code"] == "version_conflict"
        assert result.structuredContent["error"]["status_code"] == 409
        assert managed_project.tags == ["design"]
    finally:
        reset_mcp_context(context)


def test_mcp_workflow_edit_preserves_omitted_private_execution_fields(
    managed_project: CloudProject, test_db: Session, test_user: User
) -> None:
    metadata = dict(managed_project.metadata_json)
    metadata["workflow_definition"] = {
        "version": 3,
        "stage_mode": "dag",
        "execution_config": {"system_prompt": "private project configuration"},
        "nodes": [
            {
                "id": "review",
                "name": "Review",
                "execution_mode": "robot",
                "execution_config_override": True,
                "execution_config": {"system_prompt": "private node configuration"},
            }
        ],
    }
    managed_project.metadata_json = metadata
    test_db.commit()
    read = wework_project_admin.get_project_config(
        _token(test_user), str(managed_project.id)
    )
    public_workflow = read["configuration"]["workflow_definition"]
    public_workflow["nodes"][0]["name"] = "Reviewed"

    result = wework_project_admin.update_project_workflow(
        _token(test_user),
        {"version": managed_project.version, "workflow_definition": public_workflow},
        str(managed_project.id),
    )

    ProjectAdminWriteResult.model_validate(result)
    workflow = managed_project.metadata_json["workflow_definition"]
    assert workflow["nodes"][0]["name"] == "Reviewed"
    assert workflow["nodes"][0]["execution_config_override"] is True
    assert (
        workflow["nodes"][0]["execution_config"]["system_prompt"]
        == "private node configuration"
    )
    assert (
        workflow["execution_config"]["system_prompt"] == "private project configuration"
    )
    assert "private node configuration" not in str(result)
