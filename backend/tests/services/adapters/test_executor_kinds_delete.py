import json
import threading
from unittest.mock import Mock, patch

import httpx
import pytest
from fastapi import HTTPException

from app.core import payload_codec
from app.services.adapters.executor_kinds import ExecutorKindsService


@pytest.mark.unit
def test_delete_executor_task_sync_raises_on_failed_response():
    service = ExecutorKindsService(Mock())
    response = Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"status": "failed", "error_msg": "delete failed"}

    with patch("requests.post", return_value=response):
        with pytest.raises(HTTPException, match="delete failed"):
            service.delete_executor_task_sync("executor-1", "wb-plat-ide")


@pytest.mark.asyncio
async def test_delete_executor_task_async_isolates_request_and_response_codec(
    monkeypatch,
) -> None:
    loop_thread = threading.get_ident()
    decode_thread: int | None = None
    encode_thread: int | None = None
    original_encode = payload_codec._encode_http_json_bytes

    def observed_encode(payload) -> bytes:
        nonlocal encode_thread
        encode_thread = threading.get_ident()
        return original_encode(payload)

    class Response:
        content = b'{"status":"success"}'

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            nonlocal decode_thread
            decode_thread = threading.get_ident()
            return {"status": "success"}

    class Client:
        def __init__(self) -> None:
            self.post_kwargs: dict | None = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback) -> None:
            return None

        async def post(self, url: str, **kwargs):
            self.post_kwargs = {"url": url, **kwargs}
            return Response()

    client = Client()
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(
        payload_codec,
        "_encode_http_json_bytes",
        observed_encode,
    )
    service = ExecutorKindsService(Mock())
    executor_name = "x" * payload_codec.PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES

    result = await service.delete_executor_task_async(
        executor_name,
        "wb-plat-ide",
    )

    assert result == {"status": "success"}
    assert client.post_kwargs is not None
    assert json.loads(client.post_kwargs["content"]) == {
        "executor_name": executor_name,
        "executor_namespace": "wb-plat-ide",
    }
    assert client.post_kwargs["headers"] == {"Content-Type": "application/json"}
    assert decode_thread is not None
    assert decode_thread != loop_thread
    assert encode_thread is not None
    assert encode_thread != loop_thread
