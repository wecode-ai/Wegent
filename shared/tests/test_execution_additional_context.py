from shared.models.execution import ExecutionRequest


def test_execution_context_survives_serialization_without_changing_user_prompt() -> (
    None
):
    context = {
        "project": {"kind": "application", "value": "Current project reference"},
        "source": {"kind": "untrusted", "value": "Quoted source content"},
    }
    request = ExecutionRequest(prompt="User request", additional_context=context)

    wire = request.to_dict()
    restored = ExecutionRequest.from_dict(wire)

    assert wire["prompt"] == "User request"
    assert wire["additional_context"] == context
    assert restored.prompt == request.prompt
    assert restored.additional_context == context
