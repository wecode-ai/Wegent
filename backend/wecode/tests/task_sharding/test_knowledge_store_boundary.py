import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import app.services.knowledge.knowledge_base_qa_service as qa_module
import app.services.knowledge.orchestrator as orchestrator_module
import app.services.knowledge.task_knowledge_base_service as task_kb_module
import app.services.task_member_service as task_member_module
import app.stores.tasks as task_stores
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactStatus,
    KnowledgeArtifactType,
)
from app.services.knowledge.artifact_service import ArtifactService
from wecode.task_sharding.access_store import ShardedTaskAccessStore
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    subtask_model_for_task_id,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
from wecode.task_sharding.task_store import ShardedTaskStore
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)

pytestmark = pytest.mark.unit

SEQUENCE_BASE = 1 << 22


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        subtask_model_for_task_id(new_task_id(uid, 0)).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


@pytest.fixture(autouse=True)
def install_sharded_stores(monkeypatch):
    task_store = ShardedTaskStore()
    subtask_store = ShardedSubtaskStore()
    task_access_store = ShardedTaskAccessStore(task_store=task_store)
    monkeypatch.setattr(task_stores, "task_store", task_store)
    monkeypatch.setattr(task_stores, "subtask_store", subtask_store)
    monkeypatch.setattr(task_stores, "task_access_store", task_access_store)
    monkeypatch.setattr(task_kb_module, "task_store", task_store)
    monkeypatch.setattr(orchestrator_module, "task_store", task_store)
    monkeypatch.setattr(qa_module, "subtask_store", subtask_store)
    monkeypatch.setattr(
        task_member_module.task_stores, "task_access_store", task_access_store
    )


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def new_subtask_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def add_shard_group_task(
    test_db,
    *,
    user_id: int,
    sequence: int,
    labels: dict[str, str] | None = None,
):
    task_id_value = new_task_id(user_id, sequence)
    model = task_model_for_task_id(task_id_value)
    payload = {
        "kind": "Task",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {
            "name": f"task-{task_id_value}",
            "namespace": "default",
            "labels": labels or {},
        },
        "spec": {
            "title": f"task-{task_id_value}",
            "prompt": "run",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
            "is_group_chat": True,
            "knowledgeBaseRefs": [],
        },
    }
    task = model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json=payload,
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=True,
    )
    test_db.add(task)
    test_db.flush()
    return task


def add_member(test_db, *, task_id_value: int, user_id: int):
    member = ResourceMember(
        resource_type=ResourceType.TASK,
        resource_id=task_id_value,
        entity_type="user",
        entity_id=str(user_id),
        user_id=user_id,
        role=ResourceRole.Reporter.value,
        status=MemberStatus.APPROVED,
    )
    test_db.add(member)
    test_db.flush()
    return member


def add_knowledge_base(test_db, *, kb_id: int, user_id: int, name: str) -> Kind:
    kb = Kind(
        id=kb_id,
        user_id=user_id,
        kind="KnowledgeBase",
        namespace="default",
        name=f"kb-{user_id}-{name}",
        json={
            "kind": "KnowledgeBase",
            "metadata": {"name": f"kb-{user_id}-{name}", "namespace": "default"},
            "spec": {"name": name, "description": "KB description"},
        },
        is_active=True,
    )
    test_db.add(kb)
    test_db.flush()
    return kb


def add_model(test_db, *, model_id: int, user_id: int, name: str) -> Kind:
    model = Kind(
        id=model_id,
        user_id=user_id,
        kind="Model",
        namespace="default",
        name=name,
        json={
            "kind": "Model",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"modelConfig": {"model": name}},
        },
        is_active=True,
    )
    test_db.add(model)
    test_db.flush()
    return model


def add_shard_subtask(
    test_db,
    *,
    task_id_value: int,
    owner_user_id: int,
    sequence: int,
    message_id: int,
    parent_id: int,
    role: SubtaskRole,
    prompt: str = "",
    result: dict | None = None,
):
    model = subtask_model_for_task_id(task_id_value)
    now = datetime.now()
    subtask = model(
        id=new_subtask_id(owner_user_id, sequence),
        user_id=owner_user_id,
        task_id=task_id_value,
        team_id=1,
        title=f"message-{message_id}",
        bot_ids=[1],
        role=role,
        executor_namespace="",
        executor_name="",
        prompt=prompt,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=message_id,
        parent_id=parent_id,
        error_message="",
        result=result,
        completed_at=now,
        created_at=now + timedelta(seconds=message_id),
        updated_at=now + timedelta(seconds=message_id),
    )
    test_db.add(subtask)
    test_db.flush()
    return subtask


@pytest.mark.asyncio
async def test_artifact_reconcile_reads_completed_subtask_from_shard(test_db):
    owner_id = 48
    task = add_shard_group_task(test_db, user_id=owner_id, sequence=11)
    mind_map = {
        "schema_version": 1,
        "root_id": "root",
        "nodes": [
            {
                "id": "root",
                "parent_id": None,
                "title": "Root",
                "summary": "Summary",
            }
        ],
    }
    assistant = add_shard_subtask(
        test_db,
        task_id_value=task.id,
        owner_user_id=owner_id,
        sequence=12,
        message_id=2,
        parent_id=1,
        role=SubtaskRole.ASSISTANT,
        result={"value": json.dumps(mind_map)},
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    artifact = KnowledgeArtifact(
        artifact_id="artifact-sharded-subtask",
        knowledge_base_id=501,
        artifact_type=KnowledgeArtifactType.MIND_MAP,
        title="Mind map",
        status=KnowledgeArtifactStatus.RUNNING,
        task_id=task.id,
        assistant_subtask_id=assistant.id,
        source_document_ids=[101],
        user_id=owner_id,
        created_at=now,
        updated_at=now,
    )
    repository = MagicMock()
    repository.update_execution.side_effect = lambda current: current
    service = ArtifactService(
        test_db,
        SimpleNamespace(id=owner_id),
        repository,
        launcher=AsyncMock(),
    )

    reconciled = await service._reconcile_many([artifact])

    assert isinstance(service.subtask_store, ShardedSubtaskStore)
    assert reconciled[0].status == KnowledgeArtifactStatus.SUCCEEDED
    assert json.loads(reconciled[0].content or "{}") == mind_map
    repository.update_execution.assert_called_once_with(artifact)


def test_task_level_knowledge_base_reads_and_updates_sharded_task(test_db):
    owner_id = 41
    task = add_shard_group_task(test_db, user_id=owner_id, sequence=1)
    add_member(test_db, task_id_value=task.id, user_id=owner_id)
    kb = add_knowledge_base(test_db, kb_id=501, user_id=owner_id, name="Product KB")

    result = task_kb_module.task_knowledge_base_service.bind_knowledge_base(
        test_db,
        task_id=task.id,
        kb_name="Product KB",
        kb_namespace="default",
        user_id=owner_id,
    )

    assert result.id == kb.id
    assert (
        test_db.query(TaskResource).filter(TaskResource.id == task.id).first() is None
    )

    reloaded = ShardedTaskStore().get_by_id(test_db, task_id=task.id)
    assert reloaded.json["spec"]["knowledgeBaseRefs"] == [
        {
            "id": kb.id,
            "name": "Product KB",
            "boundBy": "Unknown",
            "boundAt": result.bound_at,
        }
    ]

    kb_ids = task_kb_module.task_knowledge_base_service.get_bound_knowledge_base_ids(
        test_db,
        task.id,
    )
    assert kb_ids == [kb.id]


def test_orchestrator_reads_sharded_task_model_labels(test_db):
    owner_id = 42
    model = add_model(test_db, model_id=601, user_id=owner_id, name="summary-model")
    task = add_shard_group_task(
        test_db,
        user_id=owner_id,
        sequence=5,
        labels={
            "modelId": model.name,
            "forceOverrideBotModelType": "user",
        },
    )

    result = orchestrator_module.knowledge_orchestrator.get_task_model_as_summary_model(
        test_db,
        task_id=task.id,
        user_id=owner_id,
    )

    assert (
        test_db.query(TaskResource).filter(TaskResource.id == task.id).first() is None
    )
    assert result == {
        "name": model.name,
        "namespace": "default",
        "type": "user",
    }


def test_qa_history_reads_sharded_user_and_assistant_subtasks(test_db):
    owner_id = 43
    task = add_shard_group_task(test_db, user_id=owner_id, sequence=2)
    user_subtask = add_shard_subtask(
        test_db,
        task_id_value=task.id,
        owner_user_id=owner_id,
        sequence=3,
        message_id=10,
        parent_id=9,
        role=SubtaskRole.USER,
        prompt="What is the policy?",
    )
    add_shard_subtask(
        test_db,
        task_id_value=task.id,
        owner_user_id=owner_id,
        sequence=4,
        message_id=11,
        parent_id=10,
        role=SubtaskRole.ASSISTANT,
        result={"value": "Use the documented policy."},
    )
    context = SubtaskContext(
        subtask_id=user_subtask.id,
        user_id=owner_id,
        context_type="knowledge_base",
        name="Product KB",
        extracted_text="matched chunks",
        type_data={"knowledge_id": 601, "document_count": 2},
        created_at=datetime.now(),
    )
    test_db.add(context)
    test_db.flush()

    response = qa_module.KnowledgeBaseQAService.get_qa_history(
        test_db,
        start_time=datetime.now() - timedelta(minutes=1),
        end_time=datetime.now() + timedelta(minutes=1),
        user_id=owner_id,
    )

    assert response.pagination.total == 1
    assert len(response.items) == 1
    item = response.items[0]
    assert item.task_id == task.id
    assert item.subtask_id == user_subtask.id
    assert item.user_prompt == "What is the policy?"
    assert item.assistant_answer == "Use the documented policy."
    assert item.knowledge_base_result.extracted_text == "matched chunks"
