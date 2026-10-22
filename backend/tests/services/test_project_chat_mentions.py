"""Mention recipients must match the effective project roster."""

import uuid
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.ws import wework_runtime_namespace
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemCollaborator,
    ProjectChatAgent,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.project_chat import (
    ProjectChatCommentExecution,
    ProjectChatMention,
    ProjectChatSend,
    ProjectChatSubscribe,
)
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.project_chat.comment_execution import execute_comment
from app.services.project_chat.service import project_chat_service
from tests.e2e.project_mention_runner import manage_runner
from tests.utils.collaboration import (
    authorize_project,
    authorize_project_agent,
    authorize_resource,
)


@pytest.fixture
def mention_scope(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> tuple[CloudProject, Kind, User, LoopItem, MagicMock]:
    schedule = MagicMock()
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", schedule)
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"MENTION{uuid.uuid4().hex[:6].upper()}",
        name="Mention project",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    workspace = authorize_project(test_db, project)
    recipient = User(
        user_name=f"mention-{uuid.uuid4().hex[:8]}",
        password_hash="unused",
        email="mention@example.com",
        is_active=True,
    )
    item = LoopItem(
        id=f"MENTION-{uuid.uuid4().hex[:8]}",
        cloud_project_id=project.id,
        title="Mention issue",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([recipient, item])
    test_db.commit()
    return project, workspace, recipient, item, schedule


def grant_member(
    db: Session,
    resource_type: str,
    resource_id: int | str,
    user_id: int,
    role: str,
    status: str = "approved",
) -> ResourceMember:
    grant = ResourceMember.create(
        resource_type=resource_type,
        resource_id=int(resource_id),
        entity_id=str(user_id),
        role=role,
        status=status,
    )
    db.add(grant)
    return grant


def mention_request(
    project: CloudProject, recipient: User, task_id: str | None = None
) -> ProjectChatSend:
    return ProjectChatSend(
        client_message_id=str(uuid.uuid4()),
        project_id=project.id,
        task_id=task_id,
        content=f"@{recipient.user_name} please review",
        mentions=[
            {"type": "user", "id": str(recipient.id), "label": recipient.user_name}
        ],
    )


@pytest.fixture
def assigned_mention_scope(test_db, test_user, mention_scope):
    project, workspace, recipient, item, schedule = mention_scope
    grant_member(test_db, "Workspace", workspace.id, recipient.id, "Developer")
    device = Kind(
        kind="Device",
        name="mention-runner",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"deviceType": "cloud"}},
    )
    test_db.add(device)
    test_db.flush()
    authorize_resource(test_db, project, device)
    manage_runner(test_db, item.id, "seed")
    agent = test_db.get(ProjectChatAgent, item.assignee_agent_id)
    authorize_project_agent(test_db, agent)
    item.metadata_json = {"runner_binding": {"environment_id": "999999999"}}
    test_db.commit()
    return project, recipient, item, agent, schedule


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", [False, True])
async def test_user_mentions_do_not_execute_assigned_agent(
    test_db, test_user, assigned_mention_scope, reply
):
    project, recipient, item, agent, schedule = assigned_mention_scope
    request = mention_request(project, recipient, item.id)
    if reply:
        root = ProjectChatMessage(
            message_id=str(uuid.uuid4()),
            client_message_id=str(uuid.uuid4()),
            project_id=project.id,
            task_id=item.id,
            sender_type="agent",
            sender_id=agent.id,
            sender_name=agent.name,
            agent_id=agent.id,
            content="Please review",
            status="completed",
        )
        test_db.add(root)
        test_db.commit()
        request.reply_to_message_id = root.message_id
    result = project_chat_service.send(
        test_db, user_id=test_user.id, user_name=test_user.user_name, request=request
    )
    execution_request = ProjectChatCommentExecution(
        project_id=project.id,
        task_id=item.id,
        trigger_message_id=result.message.message_id,
    )

    assert (
        await execute_comment(test_db, user_id=test_user.id, request=execution_request)
        == []
    )
    assert (
        await execute_comment(test_db, user_id=test_user.id, request=execution_request)
        == []
    )

    test_db.expire_all()
    saved = (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=result.message.message_id)
        .one()
    )
    assert saved.metadata_json["execution_dispatch"] == "comment_only"
    assert test_db.query(LoopItemExecution).count() == 0
    notification = test_db.query(WeworkNotification).one()
    assert notification.user_id == recipient.id
    assert notification.payload["commentId"] == saved.message_id
    assert item.assignee_agent_id == agent.id
    assert test_db.query(ProjectChatMessage).filter_by(
        sender_type="agent"
    ).count() == int(reply)
    schedule.assert_called_once()
    if not reply:
        manage_runner(test_db, item.id, "check")
    manage_runner(test_db, item.id, "cleanup")
    assert test_db.get(ProjectChatAgent, agent.id) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("include_member", [False, True])
async def test_agent_mentions_enqueue_before_checking_issue_runner_binding(
    test_db, test_user, assigned_mention_scope, include_member
):
    project, recipient, item, agent, _ = assigned_mention_scope
    request = mention_request(project, recipient, item.id)
    request.mentions = [
        *(request.mentions if include_member else []),
        ProjectChatMention(type="agent", id=agent.id, label=agent.name),
    ]
    result = project_chat_service.send(
        test_db, user_id=test_user.id, user_name=test_user.user_name, request=request
    )

    from app.services.loop_item_executions.service import loop_item_execution_service

    execution_request = ProjectChatCommentExecution(
        project_id=project.id,
        task_id=item.id,
        trigger_message_id=result.message.message_id,
    )
    responses = await execute_comment(
        test_db, user_id=test_user.id, request=execution_request
    )
    repeated = await execute_comment(
        test_db, user_id=test_user.id, request=execution_request
    )
    assert responses[0].message_id == repeated[0].message_id
    execution = test_db.get(LoopItemExecution, responses[0].metadata["execution_id"])
    assert execution.status == "queued"
    assert execution.assignment_pending
    assert responses[0].metadata["run_status"] == "queued"
    assert "execution_dispatch" not in result.message.metadata
    assert test_db.query(LoopItemExecution).count() == 1

    assert loop_item_execution_service.prepare_queued_assignments(test_db) == 1
    test_db.refresh(execution)
    assert execution.status == "failed"
    assert execution.error_message.startswith("ISSUE_RUNNER_CONFLICT:")
    activity = (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=responses[0].message_id)
        .one()
    )
    assert activity.status == "failed"
    assert activity.metadata_json["run_status"] == "failed"
    after_failure = await execute_comment(
        test_db, user_id=test_user.id, request=execution_request
    )
    assert after_failure[0].message_id == responses[0].message_id
    assert after_failure[0].status == "failed"
    assert test_db.query(LoopItemExecution).count() == 1
    assert (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=result.message.message_id)
        .one()
        .status
        == "completed"
    )
    assert item.assignee_agent_id == agent.id
    assert loop_item_execution_service.prepare_queued_assignments(test_db) == 0


@pytest.mark.parametrize("provider", ["github", "gitlab"])
@pytest.mark.parametrize("shadow", [False, True])
@pytest.mark.parametrize("security", ["open", "related"])
@pytest.mark.parametrize("access", ["unrelated", "assignee", "maintainer"])
@pytest.mark.parametrize("reply", [False, True])
def test_cp14_external_issue_mentions_require_provider_visibility(
    test_db,
    test_user,
    mention_scope,
    monkeypatch,
    provider,
    shadow,
    security,
    access,
    reply,
):
    """External labels govern recipients even without a local Issue row."""
    project, workspace, recipient, item, schedule = mention_scope
    project.metadata_json = {"task_provider": provider}
    task_id = f"{project.project_key}-1"
    test_db.delete(item)
    if shadow:
        test_db.add(
            LoopItem(
                id=task_id,
                cloud_project_id=project.id,
                title="External issue index",
                created_by_user_id=test_user.id,
                metadata_json={"security_level": "open"},
            )
        )
    grant_member(
        test_db,
        "Workspace",
        workspace.id,
        recipient.id,
        "Maintainer" if access == "maintainer" else "Viewer",
    )
    labels = [f"wegent:security:{security}"]
    if access == "assignee":
        labels.append(f"wegent:assignee:user:{recipient.id}")
    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        lambda _project, _number: {
            "number": 1,
            "title": "Provider issue",
            "state": "open" if provider == "github" else "opened",
            "labels": labels,
        },
    )
    test_db.commit()
    request = mention_request(project, recipient, task_id)
    if reply:
        root = project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=ProjectChatSend(
                client_message_id=str(uuid.uuid4()),
                project_id=project.id,
                task_id=task_id,
                content="Confidential external root comment",
            ),
        )
        request.reply_to_message_id = root.message.message_id

    if security == "open" or access != "unrelated":
        result = project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=request,
        )
        assert result.created
        test_db.expire_all()
        notification = test_db.query(WeworkNotification).one()
        assert notification.user_id == recipient.id
        assert notification.payload["itemId"] == task_id
        assert notification.payload["itemTitle"] == "Provider issue"
        assert task_id in notification.url
        assert test_db.query(ProjectChatMessage).count() == 1 + int(reply)
        schedule.assert_called_once()
    else:
        with pytest.raises(HTTPException) as error:
            project_chat_service.send(
                test_db,
                user_id=test_user.id,
                user_name=test_user.user_name,
                request=request,
            )
        assert error.value.status_code == 422
        assert error.value.detail == "Mentioned user cannot view this issue"
        test_db.rollback()
        assert test_db.query(ProjectChatMessage).count() == int(reply)
        assert test_db.query(WeworkNotification).count() == 0
        schedule.assert_not_called()
    assert (test_db.get(LoopItem, task_id) is not None) == shadow


@pytest.mark.parametrize("provider", ["github", "gitlab"])
@pytest.mark.parametrize("shadow", [False, True])
@pytest.mark.parametrize("operation", ["send", "subscribe"])
def test_cp14_external_issue_actor_uses_provider_visibility(
    test_db, test_user, mention_scope, monkeypatch, provider, shadow, operation
):
    """A local index must not grant the actor access to a restricted provider Issue."""
    project, workspace, actor, item, schedule = mention_scope
    project.metadata_json = {"task_provider": provider}
    task_id = f"{project.project_key}-1"
    test_db.delete(item)
    if shadow:
        test_db.add(
            LoopItem(
                id=task_id,
                cloud_project_id=project.id,
                title="External issue index",
                created_by_user_id=test_user.id,
                metadata_json={"security_level": "open"},
            )
        )
    grant_member(test_db, "Workspace", workspace.id, actor.id, "Developer")
    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        lambda _project, _number: {
            "number": 1,
            "title": "Restricted provider issue",
            "labels": ["wegent:security:related"],
        },
    )
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        if operation == "send":
            project_chat_service.send(
                test_db,
                user_id=actor.id,
                user_name=actor.user_name,
                request=mention_request(project, actor, task_id),
            )
        else:
            project_chat_service.subscribe(
                test_db,
                user_id=actor.id,
                request=ProjectChatSubscribe(project_id=project.id, task_id=task_id),
            )
    assert error.value.status_code == 404
    test_db.rollback()
    assert test_db.query(ProjectChatMessage).count() == 0
    assert test_db.query(WeworkNotification).count() == 0
    schedule.assert_not_called()


@pytest.mark.parametrize("provider", ["github", "gitlab"])
@pytest.mark.parametrize("operation", ["send", "subscribe"])
def test_cp14_external_issue_must_belong_to_requested_project(
    test_db, test_user, mention_scope, monkeypatch, provider, operation
):
    """Access to two projects must not allow a mismatched project/Issue scope."""
    project, _, _, _, schedule = mention_scope
    project.metadata_json = {"task_provider": provider}
    public_id = str(uuid.uuid4())
    other = CloudProject(
        public_id=public_id,
        project_key=f"FOREIGN{uuid.uuid4().hex[:6].upper()}",
        name="Another external project",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={"task_provider": provider},
    )
    authorize_project(test_db, other)
    test_db.commit()
    task_id = f"{other.project_key}-1"
    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        lambda _project, _number: {"number": 1, "title": "Other Issue", "labels": []},
    )

    with pytest.raises(HTTPException) as error:
        if operation == "send":
            project_chat_service.send(
                test_db,
                user_id=test_user.id,
                user_name=test_user.user_name,
                request=mention_request(project, test_user, task_id),
            )
        else:
            project_chat_service.subscribe(
                test_db,
                user_id=test_user.id,
                request=ProjectChatSubscribe(project_id=project.id, task_id=task_id),
            )
    assert error.value.status_code == 404
    test_db.rollback()
    assert test_db.query(ProjectChatMessage).count() == 0
    assert test_db.query(WeworkNotification).count() == 0
    schedule.assert_not_called()


@pytest.mark.parametrize("source", ["Workspace", "CloudProject"])
@pytest.mark.parametrize("role", ["Developer", "Viewer", "Maintainer"])
@pytest.mark.parametrize("related", [False, True])
@pytest.mark.parametrize("reply", [False, True])
def test_cp14_issue_mentions_require_recipient_visibility(
    test_db, test_user, mention_scope, source, role, related, reply
):
    """Restricted Issue content and reply previews require recipient read access."""
    project, workspace, recipient, item, schedule = mention_scope
    item.metadata_json = {"security_level": "related"}
    grant_member(
        test_db,
        source,
        workspace.id if source == "Workspace" else project.id,
        recipient.id,
        role,
    )
    if related:
        test_db.add(LoopItemCollaborator(loop_item_id=item.id, user_id=recipient.id))
    test_db.commit()
    request = mention_request(project, recipient, item.id)
    if reply:
        root = project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=ProjectChatSend(
                client_message_id=str(uuid.uuid4()),
                project_id=project.id,
                task_id=item.id,
                content="Confidential root comment",
            ),
        )
        request.reply_to_message_id = root.message.message_id

    if related or role == "Maintainer":
        result = project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=request,
        )
        assert result.created
        test_db.expire_all()
        assert test_db.query(WeworkNotification).one().user_id == recipient.id
        assert test_db.query(ProjectChatMessage).count() == 1 + int(reply)
        schedule.assert_called_once()
    else:
        with pytest.raises(HTTPException) as error:
            project_chat_service.send(
                test_db,
                user_id=test_user.id,
                user_name=test_user.user_name,
                request=request,
            )
        assert error.value.status_code == 422
        assert error.value.detail == "Mentioned user cannot view this issue"
        test_db.rollback()
        assert test_db.query(ProjectChatMessage).count() == int(reply)
        assert test_db.query(WeworkNotification).count() == 0
        schedule.assert_not_called()


@pytest.mark.parametrize("issue_thread", [False, True])
@pytest.mark.parametrize("mode", ["inherit", "restricted"])
@pytest.mark.parametrize("source", ["workspace", "direct"])
@pytest.mark.parametrize(
    "role", ["Owner", "Maintainer", "Developer", "Viewer", "Reporter"]
)
def test_cp03_cp08_cp13_mentions_follow_effective_roster(
    test_db, test_user, mention_scope, issue_thread, mode, source, role
):
    project, workspace, recipient, item, schedule = mention_scope
    project.membership_mode = mode
    grant_member(
        test_db,
        "Workspace" if source == "workspace" else "CloudProject",
        workspace.id if source == "workspace" else project.id,
        recipient.id,
        role,
    )
    test_db.commit()
    expected = (
        source == "direct" or mode == "inherit" or role in {"Owner", "Maintainer"}
    )
    roster = cloud_project_service.list_members(test_db, project.id, test_user.id)
    assert (recipient.id in {row["user_id"] for row in roster}) == expected
    request = mention_request(project, recipient, item.id if issue_thread else None)

    if expected:
        result = project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=request,
        )
        assert result.created
        test_db.expire_all()
        notification = test_db.query(WeworkNotification).one()
        assert notification.user_id == recipient.id
        assert notification.payload["commentId"] == result.message.message_id
        assert notification.payload["projectId"] == str(project.id)
        assert notification.payload.get("itemId") == request.task_id
        assert (
            test_db.query(ProjectChatMessage).one().message_id
            == notification.payload["commentId"]
        )
        schedule.assert_called_once()
    else:
        with pytest.raises(HTTPException) as error:
            project_chat_service.send(
                test_db,
                user_id=test_user.id,
                user_name=test_user.user_name,
                request=request,
            )
        assert error.value.status_code == 422
        test_db.rollback()
        assert test_db.query(ProjectChatMessage).count() == 0
        assert test_db.query(WeworkNotification).count() == 0
        schedule.assert_not_called()


@pytest.mark.parametrize("mode", ["inherit", "restricted"])
def test_cp02_mentions_include_workspace_owner_without_direct_grant(
    test_db, test_user, mention_scope, mode
):
    project, workspace, recipient, _, schedule = mention_scope
    project.membership_mode = mode
    workspace.user_id = recipient.id
    test_db.commit()

    result = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=mention_request(project, recipient),
    )

    assert result.created
    assert test_db.query(WeworkNotification).one().user_id == recipient.id
    schedule.assert_called_once()


@pytest.mark.parametrize("source", ["Workspace", "CloudProject"])
@pytest.mark.parametrize("invalid", ["pending", "rejected", "role", "inactive"])
def test_cp05_mentions_reject_invalid_memberships(
    test_db, test_user, mention_scope, source, invalid
):
    project, workspace, recipient, _, schedule = mention_scope
    grant_member(
        test_db,
        source,
        workspace.id if source == "Workspace" else project.id,
        recipient.id,
        "Unknown" if invalid == "role" else "Developer",
        invalid if invalid in {"pending", "rejected"} else "approved",
    )
    recipient.is_active = invalid != "inactive"
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=mention_request(project, recipient),
        )

    assert error.value.status_code == 422
    test_db.rollback()
    assert test_db.query(ProjectChatMessage).count() == 0
    assert test_db.query(WeworkNotification).count() == 0
    schedule.assert_not_called()


@pytest.mark.parametrize("source", ["creator", "public", "outsider", "sibling"])
def test_cp04_cp06_mentions_reject_non_participants(
    test_db, test_user, mention_scope, source
):
    project, workspace, recipient, _, schedule = mention_scope
    if source == "creator":
        project.created_by_user_id = recipient.id
    elif source == "public":
        grant = grant_member(test_db, "CloudProject", project.id, 0, "Viewer")
        grant.entity_type, grant.entity_id = "authenticated_users", "*"
    elif source == "sibling":
        public_id = str(uuid.uuid4())
        sibling = CloudProject(
            public_id=public_id,
            project_key=f"SIB{uuid.uuid4().hex[:6].upper()}",
            name="Sibling",
            created_by_user_id=test_user.id,
            storage_prefix=f"projects/{public_id}",
        )
        test_db.add(sibling)
        test_db.flush()
        parent = grant_member(
            test_db, "CloudProject", sibling.id, workspace.id, "Owner"
        )
        parent.entity_type = "workspace"
        grant_member(test_db, "CloudProject", sibling.id, recipient.id, "Developer")
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=mention_request(project, recipient),
        )

    assert error.value.status_code == 422
    test_db.rollback()
    assert test_db.query(ProjectChatMessage).count() == 0
    assert test_db.query(WeworkNotification).count() == 0
    schedule.assert_not_called()


@pytest.mark.parametrize("mode", ["inherit", "restricted"])
def test_cp05_mentions_union_valid_sources(test_db, test_user, mention_scope, mode):
    project, workspace, recipient, _, _ = mention_scope
    project.membership_mode = mode
    grant_member(test_db, "Workspace", workspace.id, recipient.id, "Maintainer")
    grant_member(test_db, "CloudProject", project.id, recipient.id, "Viewer", "pending")
    test_db.commit()

    result = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=mention_request(project, recipient),
    )

    assert result.created
    assert test_db.query(WeworkNotification).one().user_id == recipient.id


def test_cp05_mentions_revalidate_membership_after_roster_load(
    test_db, test_user, mention_scope
):
    project, workspace, recipient, _, schedule = mention_scope
    grant = grant_member(test_db, "Workspace", workspace.id, recipient.id, "Developer")
    test_db.commit()
    roster = cloud_project_service.list_members(test_db, project.id, test_user.id)
    assert recipient.id in {row["user_id"] for row in roster}
    test_db.delete(grant)
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=mention_request(project, recipient),
        )

    assert error.value.status_code == 422
    test_db.rollback()
    assert test_db.query(ProjectChatMessage).count() == 0
    assert test_db.query(WeworkNotification).count() == 0
    schedule.assert_not_called()


@pytest.mark.asyncio
async def test_websocket_mentions_commit_once_and_skip_self(
    test_db, test_user, mention_scope, monkeypatch
):
    project, workspace, recipient, _, schedule = mention_scope
    grant_member(test_db, "Workspace", workspace.id, recipient.id, "Developer")
    test_db.commit()
    request = mention_request(project, recipient)
    request.mentions = [*request.mentions, *request.mentions]
    request.mentions.extend(mention_request(project, test_user).mentions)
    namespace = wework_runtime_namespace.WeworkRuntimeNamespace()
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={"user_id": test_user.id, "user_name": test_user.user_name}
        ),
    )
    emit = AsyncMock()
    monkeypatch.setattr(namespace, "emit", emit)

    @contextmanager
    def session():
        yield test_db

    async def run_inline(fn, *args):
        return fn(*args)

    monkeypatch.setattr(wework_runtime_namespace, "get_db_session", session)
    monkeypatch.setattr(wework_runtime_namespace, "run_sync_in_executor", run_inline)
    payload = request.model_dump(by_alias=True)

    first = await namespace.on_project_chat_message_send("sender", payload)
    repeated = await namespace.on_project_chat_message_send("sender", payload)

    assert first["ok"] and first["created"]
    assert repeated["ok"] and not repeated["created"]
    assert first["result"]["messageId"] == repeated["result"]["messageId"]
    assert test_db.query(ProjectChatMessage).count() == 1
    assert test_db.query(WeworkNotification).one().user_id == recipient.id
    schedule.assert_called_once()
    emit.assert_awaited_once()
