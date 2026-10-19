# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy

import httpx
import pytest
from pydantic import ValidationError

from app.schemas.admin import PublicModelCreate
from app.schemas.decision import DecisionRequest
from app.schemas.kind import ModelSpec
from app.services.decision_protocol import (
    build_decision_payload,
    normalize_decision_response,
)
from app.services.model_connection_service import _test_llm_connection
from shared.utils.decision_model import decision_endpoint


def request() -> DecisionRequest:
    return DecisionRequest(
        model="catalog-id",
        state={"message": "Export failed"},
        questions={
            "urgent": {"type": "noul", "instructions": "Is it urgent?"},
            "department": {
                "type": "choice",
                "instructions": {"question": "Who handles it?"},
                "criteria": {"billing": "Payments", "technical": None},
            },
            "severity": {
                "type": "score",
                "instructions": "How severe?",
                "criteria": ["Minor", {"description": "Blocked"}],
            },
        },
    )


@pytest.mark.parametrize(
    ("protocol", "base", "expected"),
    [
        ("systemone", "https://example.com", "https://example.com/v1/systemone"),
        ("systemone", "https://example.com/v1/", "https://example.com/v1/systemone"),
        (
            "openai",
            "https://example.com/v1/decisions",
            "https://example.com/v1/decisions",
        ),
        (
            "openai",
            "https://example.com/prefix/v1",
            "https://example.com/prefix/v1/decisions",
        ),
    ],
)
def test_endpoint_uses_the_declared_protocol(
    protocol: str, base: str, expected: str
) -> None:
    assert decision_endpoint(base, protocol) == expected


@pytest.mark.parametrize(
    "base",
    [
        "http://example.com/v1",
        "https://user:private@example.com/v1",
        "https://example.com/v1?key=private",
        "https://example.com/v1#private",
        "https://example.com/v1?",
        "https://example.com/v1/systemone",
        "https://example.com/chat/completions",
        "https://example.com:invalid/v1",
    ],
)
def test_invalid_endpoint_is_rejected_without_echoing_values(base: str) -> None:
    with pytest.raises(ValueError) as error:
        decision_endpoint(base, "openai")
    assert "private" not in str(error.value)


def test_systemone_preserves_structure_and_openai_translates_questions() -> None:
    body = request()
    systemone = build_decision_payload(body, "systemone", "provider-id")
    assert systemone["state"] == body.state
    assert systemone["questions"]["department"]["criteria"]["technical"] is None
    assert systemone["model"] == "provider-id"

    openai = build_decision_payload(body, "openai", "provider-id")
    assert openai["input"] == '{"message": "Export failed"}'
    assert openai["questions"][0] == {
        "type": "predicate",
        "name": "urgent",
        "instructions": "Is it urgent?",
    }
    assert openai["questions"][1]["choices"] == [
        {"value": "billing", "description": "Payments"},
        {"value": "technical", "description": ""},
    ]
    assert openai["questions"][2]["levels"][1] == {
        "label": "1",
        "description": '{"description": "Blocked"}',
    }


def test_openai_noul_criteria_are_preserved_in_instructions() -> None:
    body = request()
    body.questions["urgent"].criteria = {"true": "Time sensitive", "false": "Can wait"}
    question = build_decision_payload(body, "openai", "provider-id")["questions"][0]
    assert "Time sensitive" in question["instructions"]
    assert "Can wait" in question["instructions"]


def openai_response() -> dict:
    return {
        "model": "provider-id",
        "debug": "private-provider-key",
        "answers": [
            {
                "name": "urgent",
                "type": "predicate",
                "probability": 0.9,
                "debug": "private",
            },
            {
                "name": "department",
                "type": "choice",
                "choice": "technical",
                "confidence": 0.8,
                "probabilities": [
                    {"value": "technical", "probability": 0.9},
                    {"value": "billing", "probability": 0.1},
                ],
            },
            {
                "name": "severity",
                "type": "score",
                "score": 0.8,
                "confidence": 0.7,
                "probabilities": [
                    {"value": 0, "probability": 0.2},
                    {"value": 1, "probability": 0.8},
                ],
            },
        ],
        "usage": {"input_tokens": 20, "debug": "private"},
    }


def test_responses_normalize_to_the_same_safe_contract() -> None:
    body = request()
    result = normalize_decision_response(openai_response(), body, "openai")
    assert result["model"] == "catalog-id"
    assert result["answers"]["urgent"] == {"type": "noul", "noul": 0.9}
    assert result["answers"]["department"]["probabilities"] == {
        "billing": 0.1,
        "technical": 0.9,
    }
    assert result["answers"]["severity"]["legend"]["1"] == '{"description": "Blocked"}'
    assert result["usage"] == {"input_tokens": 20}
    assert "private" not in str(result)
    assert normalize_decision_response(result, body, "systemone") == result


@pytest.mark.parametrize(
    "problem",
    ["missing", "duplicate", "wrong_type", "nan", "out_of_range", "wrong_choice"],
)
def test_malformed_answers_are_rejected(problem: str) -> None:
    response = deepcopy(openai_response())
    if problem == "missing":
        response["answers"].pop()
    elif problem == "duplicate":
        response["answers"][2] = response["answers"][0]
    elif problem == "wrong_type":
        response["answers"][0]["type"] = "choice"
    elif problem == "nan":
        response["answers"][0]["probability"] = float("nan")
    elif problem == "out_of_range":
        response["answers"][0]["probability"] = 1.5
    else:
        response["answers"][1]["choice"] = "unexpected"
    with pytest.raises(ValueError):
        normalize_decision_response(response, request(), "openai")


def test_openai_refusal_is_preserved_without_provider_details() -> None:
    response = openai_response()
    response["answers"][0] = {"name": "urgent", "type": "refusal", "reason": "private"}
    result = normalize_decision_response(response, request(), "openai")
    assert result["answers"]["urgent"] == {"type": "refusal"}


@pytest.mark.parametrize(
    "question",
    [
        {"type": "choice", "instructions": "Question", "criteria": {}},
        {"type": "score", "instructions": "Question", "criteria": ["Only one"]},
        {"type": "unknown", "instructions": "Question"},
        {"type": "noul", "instructions": "", "endpoint": "injected"},
    ],
)
def test_request_validates_question_types_and_criteria(question: dict) -> None:
    with pytest.raises(ValidationError):
        DecisionRequest(model="catalog-id", state="text", questions={"q": question})


@pytest.mark.parametrize("protocol", ["systemone", "openai"])
def test_user_and_admin_schemas_support_decision_models(protocol: str) -> None:
    spec = {
        "modelType": "decision",
        "protocol": protocol,
        "modelConfig": {
            "env": {
                "model": protocol,
                "model_id": "provider-id",
                "base_url": "https://example.com/v1",
                "api_key": "private-provider-key",
            }
        },
    }
    assert ModelSpec.model_validate(spec).modelType.value == "decision"
    public = PublicModelCreate(
        name="decision-model",
        json={"kind": "Model", "metadata": {"name": "decision-model"}, "spec": spec},
    )
    assert public.model_json["spec"]["protocol"] == protocol
    spec["protocol"] = "invalid"
    with pytest.raises(ValidationError) as error:
        ModelSpec.model_validate(spec)
    assert "private-provider-key" not in str(error.value)


@pytest.mark.parametrize("model_id", ["decision model", "model?name", "x" * 129])
def test_decision_model_id_is_validated_before_publication(model_id: str) -> None:
    spec = {
        "modelType": "decision",
        "protocol": "systemone",
        "modelConfig": {
            "env": {
                "model_id": model_id,
                "base_url": "https://example.com/v1",
                "api_key": "private-provider-key",
            }
        },
    }
    with pytest.raises(ValidationError, match="valid model identifier") as error:
        ModelSpec.model_validate(spec)
    assert "private-provider-key" not in str(error.value)


@pytest.mark.parametrize("protocol", ["systemone", "openai"])
def test_connection_checks_call_decision_endpoints(
    protocol: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = []

    def provider(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert (
            request.url.path
            == f"/v1/{'systemone' if protocol == 'systemone' else 'decisions'}"
        )
        assert request.headers["authorization"] == "Bearer test-key"
        answers = (
            {"connected": {"type": "noul", "noul": 1}}
            if protocol == "systemone"
            else [{"name": "connected", "type": "predicate", "probability": 1}]
        )
        return httpx.Response(200, json={"answers": answers})

    client = httpx.Client
    monkeypatch.setattr(
        "app.services.decision_model_service.httpx.Client",
        lambda **kwargs: client(transport=httpx.MockTransport(provider), **kwargs),
    )
    result = _test_llm_connection(
        provider_type=protocol,
        model_id="provider-model",
        api_key="test-key",
        base_url="https://provider.example/v1",
        custom_headers={},
        model_category_type="decision",
    )
    assert result["success"] is True
    assert len(calls) == 1
