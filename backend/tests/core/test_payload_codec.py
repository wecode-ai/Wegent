# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace

import pytest

from app.core import payload_codec
from app.core.bounded_executor import BoundedExecutor


async def _wait_until_set(event: threading.Event) -> None:
    for _ in range(100):
        if event.is_set():
            return
        await asyncio.sleep(0.001)
    raise AssertionError("worker did not start")


@pytest.mark.asyncio
async def test_payload_codec_submission_is_bounded(monkeypatch) -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        thread_name_prefix="test-payload-codec",
    )
    monkeypatch.setattr(payload_codec, "_payload_codec_executor", executor)
    first_started = threading.Event()
    release_first = threading.Event()
    calls: list[int] = []

    def blocking_codec(value: int) -> int:
        calls.append(value)
        if value == 1:
            first_started.set()
            assert release_first.wait(timeout=1)
        return value

    large_payload = "x" * payload_codec.PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES
    first = asyncio.create_task(
        payload_codec.run_payload_codec(
            blocking_codec,
            1,
            payload_hint=large_payload,
        )
    )
    second = asyncio.create_task(
        payload_codec.run_payload_codec(
            blocking_codec,
            2,
            payload_hint=large_payload,
        )
    )

    await _wait_until_set(first_started)
    await asyncio.sleep(0.01)
    assert calls == [1]
    assert not second.done()

    release_first.set()
    assert await asyncio.gather(first, second) == [1, 2]
    assert calls == [1, 2]


def test_payload_offload_check_does_not_iterate_an_unbounded_container() -> None:
    large_payload = [None] * payload_codec.PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES

    assert payload_codec.payload_requires_codec_offload(large_payload) is True


def test_payload_offload_check_does_not_invoke_custom_container_hooks() -> None:
    class CustomList(list[None]):
        def __len__(self):
            raise AssertionError("custom length hooks must not run on the event loop")

        def __iter__(self):
            raise AssertionError("custom iterators must not run on the event loop")

    payload = CustomList([None])

    assert payload_codec.payload_requires_codec_offload(payload) is True


@pytest.mark.asyncio
async def test_large_httpx_json_encode_runs_outside_event_loop(monkeypatch) -> None:
    loop_thread = threading.get_ident()
    encoder_thread: int | None = None
    original_encode = payload_codec._encode_http_json_bytes

    def observed_encode(payload: object) -> bytes:
        nonlocal encoder_thread
        encoder_thread = threading.get_ident()
        return original_encode(payload)

    monkeypatch.setattr(
        payload_codec,
        "_encode_http_json_bytes",
        observed_encode,
    )
    value = "中" * payload_codec.PAYLOAD_CODEC_OFFLOAD_THRESHOLD_BYTES

    encoded = await payload_codec.encode_http_json({"value": value})

    assert encoded.startswith(b'{"value":"')
    assert encoded.endswith(b'"}')
    assert encoder_thread is not None
    assert encoder_thread != loop_thread


@pytest.mark.asyncio
async def test_pydantic_projection_helpers_run_outside_event_loop() -> None:
    loop_thread = threading.get_ident()
    calls: list[tuple[str, int]] = []

    class Model:
        def model_dump(self, **kwargs):
            calls.append((f"dump:{kwargs['mode']}", threading.get_ident()))
            return {"ok": True}

        def model_dump_json(self, **kwargs):
            calls.append((f"json:{kwargs['indent']}", threading.get_ident()))
            return '{"ok":true}'

    class ModelType:
        @staticmethod
        def model_validate(payload, **kwargs):
            calls.append((f"validate:{kwargs['strict']}", threading.get_ident()))
            return payload

    class ProjectModelType:
        @staticmethod
        def model_validate(payload):
            calls.append(("project", threading.get_ident()))
            return Model()

    model = Model()
    assert await payload_codec.dump_model(model, mode="json") == {"ok": True}
    assert await payload_codec.dump_model_json(model, indent=0) == '{"ok":true}'
    assert await payload_codec.validate_model(
        ModelType,
        {"ok": True},
        strict=True,
    ) == {"ok": True}
    assert await payload_codec.dump_models(
        [model, model],
        mode="json",
    ) == [{"ok": True}, {"ok": True}]
    assert await payload_codec.project_model(
        ProjectModelType,
        {"ok": True},
        mode="json",
    ) == {"ok": True}

    assert [name for name, _ in calls] == [
        "dump:json",
        "json:0",
        "validate:True",
        "dump:json",
        "dump:json",
        "project",
        "dump:json",
    ]
    assert all(thread_id != loop_thread for _, thread_id in calls)


@pytest.mark.asyncio
async def test_httpx_json_encode_preserves_wire_format_and_nan_policy() -> None:
    assert await payload_codec.encode_http_json(
        {"text": "中文", "values": [1, True, None]}
    ) == '{"text":"中文","values":[1,true,null]}'.encode("utf-8")

    with pytest.raises(ValueError, match="Out of range float values"):
        await payload_codec.encode_http_json({"value": float("nan")})


@pytest.mark.asyncio
async def test_sync_response_json_decode_runs_outside_event_loop() -> None:
    loop_thread = threading.get_ident()
    decoder_thread: int | None = None

    def decode() -> dict[str, bool]:
        nonlocal decoder_thread
        decoder_thread = threading.get_ident()
        return {"ok": True}

    response = SimpleNamespace(content=b'{"ok":true}', json=decode)

    assert await payload_codec.decode_sync_response_json(response) == {"ok": True}
    assert decoder_thread is not None
    assert decoder_thread != loop_thread


@pytest.mark.asyncio
async def test_sync_response_text_decode_runs_outside_event_loop() -> None:
    loop_thread = threading.get_ident()
    decoder_thread: int | None = None

    class Response:
        content = "中文".encode("utf-8")

        @property
        def text(self) -> str:
            nonlocal decoder_thread
            decoder_thread = threading.get_ident()
            return "中文"

    assert await payload_codec.decode_sync_response_text(Response()) == "中文"
    assert decoder_thread is not None
    assert decoder_thread != loop_thread


@pytest.mark.asyncio
async def test_sync_response_text_empty_body_skips_encoding() -> None:
    class Response:
        content = b""

        @property
        def text(self) -> str:
            raise AssertionError("empty responses must not invoke the decoder")

    assert await payload_codec.decode_sync_response_text(Response()) == ""


@pytest.mark.asyncio
async def test_async_response_json_decode_runs_outside_event_loop(
    monkeypatch,
) -> None:
    loop_thread = threading.get_ident()
    decoder_thread: int | None = None
    original_decode = payload_codec._decode_json_bytes

    def observed_decode(body: bytes, encoding: str) -> object:
        nonlocal decoder_thread
        decoder_thread = threading.get_ident()
        return original_decode(body, encoding)

    class Response:
        async def read(self) -> bytes:
            return b'{"ok":true}'

        def get_encoding(self) -> str:
            return "utf-8"

    monkeypatch.setattr(payload_codec, "_decode_json_bytes", observed_decode)

    assert await payload_codec.decode_async_response_json(Response()) == {"ok": True}
    assert decoder_thread is not None
    assert decoder_thread != loop_thread


@pytest.mark.asyncio
async def test_async_response_json_empty_body_preserves_aiohttp_semantics() -> None:
    class Response:
        async def read(self) -> bytes:
            return b"  "

        def get_encoding(self) -> str:
            raise AssertionError("empty responses must not resolve an encoding")

    assert await payload_codec.decode_async_response_json(Response()) is None


@pytest.mark.asyncio
async def test_async_response_text_decode_and_encoding_run_outside_event_loop(
    monkeypatch,
) -> None:
    loop_thread = threading.get_ident()
    encoding_thread: int | None = None
    decoder_thread: int | None = None
    original_decode = payload_codec._decode_async_response_text_bytes

    def observed_decode(response: object, body: bytes) -> str:
        nonlocal decoder_thread
        decoder_thread = threading.get_ident()
        return original_decode(response, body)

    class Response:
        async def read(self) -> bytes:
            return "café".encode("latin-1")

        def get_encoding(self) -> str:
            nonlocal encoding_thread
            encoding_thread = threading.get_ident()
            return "latin-1"

    monkeypatch.setattr(
        payload_codec,
        "_decode_async_response_text_bytes",
        observed_decode,
    )

    assert await payload_codec.decode_async_response_text(Response()) == "café"
    assert encoding_thread is not None
    assert encoding_thread != loop_thread
    assert decoder_thread is not None
    assert decoder_thread != loop_thread


@pytest.mark.asyncio
async def test_async_response_text_empty_body_preserves_encoding_semantics() -> None:
    encoding_resolved = False

    class Response:
        async def read(self) -> bytes:
            return b""

        def get_encoding(self) -> str:
            nonlocal encoding_resolved
            encoding_resolved = True
            return "utf-8"

    assert await payload_codec.decode_async_response_text(Response()) == ""
    assert encoding_resolved is True
