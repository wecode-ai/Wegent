"""Runner queue selection uses the original schema and serialized intent."""

import json

import pytest
from sqlalchemy import inspect
from sqlalchemy.dialects import mysql

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution


@pytest.mark.parametrize(
    "payload, routed",
    [
        ("", False),
        ("invalid", False),
        ("null", False),
        ("[]", False),
        ("{}", False),
        ('{"runtime_selection":{"runner_routing":null}}', False),
        ('{"runtime_selection":{"runner_routing":"invalid"}}', False),
        ('{"runtime_selection":{"runner_routing":[]}}', False),
        ('{"runtime_selection":{"runner_routing":{}}}', True),
        ('{"runtime_selection":{"runner_routing":{"version":1}}}', True),
        ('{"runner_routing":{"version":1}}', True),
        ('{"runtime_selection":{},"runner_routing":{}}', False),
        ('{"runtime_selection":{"runner_routing":{}},"runner_routing":null}', True),
    ],
)
def test_python_and_queue_sql_identify_the_same_routing(test_db, payload, routed):
    execution = LoopItemExecution(execution_payload=payload, status="queued")
    test_db.add(execution)
    test_db.flush()

    assert execution.uses_runner_routing is routed
    selected = (
        test_db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.uses_runner_routing, LoopItemExecution.id == execution.id
        )
        .first()
    )
    assert (selected is not None) is routed
    assert (
        test_db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.uses_runner_routing == routed,
            LoopItemExecution.id == execution.id,
        )
        .first()
        is execution
    )


def test_original_tables_have_no_feature_columns(test_db):
    inspector = inspect(test_db.get_bind())
    assert "runner_environment_id" not in {
        column["name"] for column in inspector.get_columns("loop_items")
    }
    assert "routing_version" not in {
        column["name"] for column in inspector.get_columns("loop_item_executions")
    }
    test_db.add(LoopItem(id="original-schema", title="Issue", metadata_json={}))
    test_db.add(
        LoopItemExecution(
            loop_item_id="original-schema", execution_payload=json.dumps({})
        )
    )
    test_db.flush()
    assert test_db.get(LoopItem, "original-schema").title == "Issue"


def test_mysql_queue_query_uses_existing_payload_column(test_db):
    query = test_db.query(LoopItemExecution).filter(
        LoopItemExecution.uses_runner_routing
    )
    sql = str(query.statement.compile(dialect=mysql.dialect()))
    assert "JSON_EXTRACT" in sql
    assert "execution_payload" in sql
    assert "routing_version" not in sql
