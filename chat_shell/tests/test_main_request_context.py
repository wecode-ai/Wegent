from chat_shell.main import _extract_request_context


def test_extract_request_context_from_responses_metadata_task_fields_only():
    body = {
        "model": "test-model",
        "input": "hello",
        "metadata": {
            "task_id": 123,
            "subtask_id": 456,
            "user_id": 789,
            "user_name": "alice",
        },
    }

    assert _extract_request_context(body) == {
        "task_id": 123,
        "subtask_id": 456,
    }


def test_extract_request_context_prefers_legacy_top_level_fields():
    body = {
        "metadata": {
            "task_id": 123,
            "subtask_id": 456,
            "user_id": 789,
            "user_name": "alice",
        },
        "task_id": 321,
        "subtask_id": 654,
        "user_id": 987,
        "user_name": "bob",
    }

    assert _extract_request_context(body) == {
        "task_id": 321,
        "subtask_id": 654,
    }
