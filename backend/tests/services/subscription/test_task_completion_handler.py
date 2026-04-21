from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.subscription import (
    BackgroundExecutionStatus,
    SubscriptionExecutionTargetType,
)


@pytest.mark.asyncio
async def test_completed_managed_subscription_deletes_executor_immediately():
    """Managed subscription completions should delete the executor immediately."""
    from app.core.events import TaskCompletedEvent
    from app.models.kind import Kind
    from app.models.subtask import Subtask
    from app.services.subscription.task_completion_handler import (
        SubscriptionTaskCompletionHandler,
    )

    handler = SubscriptionTaskCompletionHandler()
    execution = SimpleNamespace(
        id=11,
        subscription_id=22,
        status=BackgroundExecutionStatus.RUNNING.value,
        inbox_message_id=0,
    )
    subscription = SimpleNamespace(id=22, name="daily-briefing", json={})
    subtask = SimpleNamespace(
        id=33,
        task_id=44,
        executor_name="executor-subscription-1",
        executor_namespace="default",
        executor_deleted_at=False,
    )

    subscription_query = MagicMock()
    subscription_query.filter.return_value = subscription_query
    subscription_query.first.return_value = subscription

    subtask_query = MagicMock()
    subtask_query.filter.return_value = subtask_query
    subtask_query.all.return_value = [subtask]

    db = MagicMock()

    def query_side_effect(model):
        if model == Kind:
            return subscription_query
        if model == Subtask:
            return subtask_query
        raise AssertionError(f"Unexpected model query: {model}")

    db.query.side_effect = query_side_effect

    @contextmanager
    def fake_db_session():
        yield db

    event = TaskCompletedEvent(
        task_id=44,
        subtask_id=33,
        user_id=1,
        status="COMPLETED",
        result={"value": "done"},
        error=None,
    )

    subscription_crd = SimpleNamespace(
        spec=SimpleNamespace(
            displayName="Daily Briefing",
            executionTarget=SimpleNamespace(
                type=SubscriptionExecutionTargetType.MANAGED
            ),
        )
    )

    with (
        patch.object(handler, "_find_execution_by_task_id", return_value=execution),
        patch.object(handler, "_extract_result_summary", return_value="done"),
        patch.object(handler, "_dispatch_notifications", new=AsyncMock()),
        patch.object(handler.execution_manager, "update_execution_status"),
        patch(
            "app.services.subscription.task_completion_handler.get_db_session",
            fake_db_session,
        ),
        patch(
            "app.services.subscription.task_completion_handler.validate_subscription_for_read",
            return_value=subscription_crd,
        ),
        patch(
            "app.services.subscription.task_completion_handler.get_executor_runtime_client"
        ) as runtime_client_factory,
        patch(
            "app.services.subscription.task_completion_handler.executor_kinds_service"
        ) as executor_service,
    ):
        runtime_client = MagicMock()
        runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        runtime_client_factory.return_value = runtime_client
        executor_service.delete_executor_task_async = AsyncMock(
            return_value={"status": "success"}
        )
        await handler.on_task_completed(event)

    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-subscription-1",
        "default",
    )
    runtime_client.delete_sandbox.assert_not_called()
    assert subtask.executor_deleted_at is True
    db.commit.assert_called()


@pytest.mark.asyncio
async def test_completed_subscription_deletes_executor_without_managed_target():
    """Executor-backed subscription tasks should be cleaned even without managed target metadata."""
    from app.core.events import TaskCompletedEvent
    from app.models.kind import Kind
    from app.models.subtask import Subtask
    from app.services.subscription.task_completion_handler import (
        SubscriptionTaskCompletionHandler,
    )

    handler = SubscriptionTaskCompletionHandler()
    execution = SimpleNamespace(
        id=11,
        subscription_id=22,
        status=BackgroundExecutionStatus.RUNNING.value,
        inbox_message_id=0,
    )
    subscription = SimpleNamespace(id=22, name="daily-briefing", json={})
    subtask = SimpleNamespace(
        id=33,
        task_id=44,
        executor_name="executor-subscription-1",
        executor_namespace="default",
        executor_deleted_at=False,
    )

    subscription_query = MagicMock()
    subscription_query.filter.return_value = subscription_query
    subscription_query.first.return_value = subscription

    subtask_query = MagicMock()
    subtask_query.filter.return_value = subtask_query
    subtask_query.all.return_value = [subtask]

    db = MagicMock()

    def query_side_effect(model):
        if model == Kind:
            return subscription_query
        if model == Subtask:
            return subtask_query
        raise AssertionError(f"Unexpected model query: {model}")

    db.query.side_effect = query_side_effect

    @contextmanager
    def fake_db_session():
        yield db

    event = TaskCompletedEvent(
        task_id=44,
        subtask_id=33,
        user_id=1,
        status="COMPLETED",
        result={"value": "done"},
        error=None,
    )

    subscription_crd = SimpleNamespace(
        spec=SimpleNamespace(
            displayName="Daily Briefing",
            executionTarget=None,
        )
    )

    with (
        patch.object(handler, "_find_execution_by_task_id", return_value=execution),
        patch.object(handler, "_extract_result_summary", return_value="done"),
        patch.object(handler, "_dispatch_notifications", new=AsyncMock()),
        patch.object(handler.execution_manager, "update_execution_status"),
        patch(
            "app.services.subscription.task_completion_handler.get_db_session",
            fake_db_session,
        ),
        patch(
            "app.services.subscription.task_completion_handler.validate_subscription_for_read",
            return_value=subscription_crd,
        ),
        patch(
            "app.services.subscription.task_completion_handler.get_executor_runtime_client"
        ) as runtime_client_factory,
        patch(
            "app.services.subscription.task_completion_handler.executor_kinds_service"
        ) as executor_service,
    ):
        runtime_client = MagicMock()
        runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        runtime_client_factory.return_value = runtime_client
        executor_service.delete_executor_task_async = AsyncMock(
            return_value={"status": "success"}
        )
        await handler.on_task_completed(event)

    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-subscription-1",
        "default",
    )
    runtime_client.delete_sandbox.assert_not_called()
    assert subtask.executor_deleted_at is True
    db.commit.assert_called()


@pytest.mark.asyncio
async def test_completed_subscription_deletes_sandbox_runtime_immediately():
    """Sandbox-backed subscription completions should terminate sandbox runtime even without executor binding."""
    from app.core.events import TaskCompletedEvent
    from app.models.kind import Kind
    from app.models.subtask import Subtask
    from app.services.subscription.task_completion_handler import (
        SubscriptionTaskCompletionHandler,
    )

    handler = SubscriptionTaskCompletionHandler()
    execution = SimpleNamespace(
        id=11,
        subscription_id=22,
        status=BackgroundExecutionStatus.RUNNING.value,
        inbox_message_id=0,
    )
    subscription = SimpleNamespace(id=22, name="daily-briefing", json={})
    subtask = SimpleNamespace(
        id=33,
        task_id=44,
        executor_name=None,
        executor_namespace=None,
        executor_deleted_at=False,
    )

    subscription_query = MagicMock()
    subscription_query.filter.return_value = subscription_query
    subscription_query.first.return_value = subscription

    class FakeSubtaskQuery:
        def __init__(self, items):
            self._items = items
            self._filters = ()

        def filter(self, *criteria):
            self._filters = criteria
            return self

        def all(self):
            filter_sql = {str(criteria) for criteria in self._filters}
            if "subtasks.executor_name IS NOT NULL" in filter_sql:
                return []
            return list(self._items)

    db = MagicMock()

    def query_side_effect(model):
        if model == Kind:
            return subscription_query
        if model == Subtask:
            return FakeSubtaskQuery([subtask])
        raise AssertionError(f"Unexpected model query: {model}")

    db.query.side_effect = query_side_effect

    @contextmanager
    def fake_db_session():
        yield db

    event = TaskCompletedEvent(
        task_id=44,
        subtask_id=33,
        user_id=1,
        status="COMPLETED",
        result={"value": "done"},
        error=None,
    )

    subscription_crd = SimpleNamespace(
        spec=SimpleNamespace(
            displayName="Daily Briefing",
            executionTarget=None,
        )
    )

    with (
        patch.object(handler, "_find_execution_by_task_id", return_value=execution),
        patch.object(handler, "_extract_result_summary", return_value="done"),
        patch.object(handler, "_dispatch_notifications", new=AsyncMock()),
        patch.object(handler.execution_manager, "update_execution_status"),
        patch(
            "app.services.subscription.task_completion_handler.get_db_session",
            fake_db_session,
        ),
        patch(
            "app.services.subscription.task_completion_handler.validate_subscription_for_read",
            return_value=subscription_crd,
        ),
        patch(
            "app.services.subscription.task_completion_handler.get_executor_runtime_client"
        ) as runtime_client_factory,
        patch(
            "app.services.subscription.task_completion_handler.executor_kinds_service"
        ) as executor_service,
    ):
        runtime_client = MagicMock()
        runtime_client.get_sandbox = AsyncMock(
            return_value=({"status": "running", "base_url": "http://sandbox"}, None)
        )
        runtime_client.delete_sandbox = AsyncMock(return_value=(True, None))
        runtime_client_factory.return_value = runtime_client
        executor_service.delete_executor_task_async = AsyncMock(
            return_value={"status": "success"}
        )
        await handler.on_task_completed(event)

    runtime_client.get_sandbox.assert_awaited_once_with("44")
    runtime_client.delete_sandbox.assert_awaited_once_with("44")
    executor_service.delete_executor_task_async.assert_not_awaited()
    assert subtask.executor_deleted_at is True
    db.commit.assert_called()
