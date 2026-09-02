# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep FastAPI and Starlette form processing off the Uvicorn event loop.

The ASGI receive loop remains asynchronous and streaming. Only each parser
step, spooled-file operation, and FastAPI form extraction/validation phase is
submitted to Wegent-owned bounded executors. This module is the single,
version-locked adapter for the private framework behavior required to do that.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import inspect
import threading
from contextlib import AsyncExitStack
from dataclasses import dataclass
from functools import lru_cache
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncGenerator,
    BinaryIO,
    Callable,
    Dict,
    List,
    TypeVar,
)
from urllib.parse import unquote_plus

import fastapi
import python_multipart
import starlette
from fastapi._compat import ModelField
from fastapi.dependencies.utils import _extract_form_body as fastapi_extract_form_body
from fastapi.dependencies.utils import (
    request_body_to_args,
)
from python_multipart import MultipartParser as PythonMultipartParser
from python_multipart import QuerystringParser
from python_multipart.multipart import parse_options_header
from starlette.datastructures import FormData, Headers, UploadFile
from starlette.exceptions import HTTPException
from starlette.formparsers import (
    FormMessage,
    FormParser,
    MultiPartException,
    MultiPartParser,
)
from starlette.requests import Request

from app.core.bounded_executor import (
    BoundedExecutor,
    BoundedExecutorOverloaded,
    run_bounded_to_completion,
)
from app.core.request_body_limit import (
    REQUEST_BODY_ADMISSION_MAX_MULTIPART_REQUESTS,
)

if TYPE_CHECKING:
    from python_multipart.multipart import MultipartCallbacks, QuerystringCallbacks

T = TypeVar("T")

SUPPORTED_FASTAPI_VERSION = "0.124.0"
SUPPORTED_STARLETTE_VERSION = "0.50.0"
SUPPORTED_PYTHON_MULTIPART_VERSION = "0.0.20"
_FORM_MAX_IN_FLIGHT = REQUEST_BODY_ADMISSION_MAX_MULTIPART_REQUESTS
_FORM_MAX_WAITERS = _FORM_MAX_IN_FLIGHT * 2
_FORM_CLEANUP_WORKERS = _FORM_MAX_IN_FLIGHT
_IN_FORM_EXECUTOR: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "wegent_in_form_executor",
    default=False,
)
_EXPECTED_SOURCE_HASHES: Dict[str, tuple[Callable[..., Any], str]] = {
    "Request.form": (
        Request.form,
        "e18549ecc0ecdee354a349be9541e19b8fce8b66aadbc732c56c526b57f5d12a",
    ),
    "Request._get_form": (
        Request._get_form,
        "c5978a939195b4cfb7587bf96861f68dba49ad8d2d4e2aa2e8a44fd464db9ab7",
    ),
    "MultiPartParser.__init__": (
        MultiPartParser.__init__,
        "8942551c3d9d5c189657a77c82ef40460041e316a247ce034950343fd152ecd7",
    ),
    "MultiPartParser.on_headers_finished": (
        MultiPartParser.on_headers_finished,
        "10922cc93ae5c5ac522e00bf88a71f0ce745bc28fc49f8932b751c50fced0c0f",
    ),
    "MultiPartParser.parse": (
        MultiPartParser.parse,
        "e63bc3bdc6c7c397f187847d7fd5e84fc1ca301e530030f0dd44e2c0883396aa",
    ),
    "FormParser.__init__": (
        FormParser.__init__,
        "97375883f2c4cb67ffbfcbf9a9bb365374561f4d568ea7da4ea2d7bd4020a897",
    ),
    "FormParser.parse": (
        FormParser.parse,
        "705f5a972e202cf5a382076c8934f4f55c80f3dc3caedfd94c661ae1a1812031",
    ),
    "UploadFile.__init__": (
        UploadFile.__init__,
        "3b59ccc2ea552c22906777366bf0ce79dbfe64ebfc12fb2d4b4d49bca3986e06",
    ),
    "UploadFile.write": (
        UploadFile.write,
        "74c4349d6436f40ccda2982ef01e8004458bca23035a117a97feb352796245b7",
    ),
    "UploadFile.read": (
        UploadFile.read,
        "36d9e243b2c2ec4f5181dce7eeed1a2a3ed4d83a38273edcec6e34cd0daabbe5",
    ),
    "UploadFile.seek": (
        UploadFile.seek,
        "c768f6c18c39d758ecdfc33ea0b56738ae6398e7d8cab7ccecb2b7d2aca8d394",
    ),
    "UploadFile.close": (
        UploadFile.close,
        "eb4bad7a39dadd613368e0ec11e62c8d930a7c3350534e4187e05eaa7e5a2ef8",
    ),
    "FormData.close": (
        FormData.close,
        "7a8ebb4c40925db01b734e2cc04c3999647c9b801eb8498b9971506f6913a45d",
    ),
    "_extract_form_body": (
        fastapi_extract_form_body,
        "f20b42c36a95582d260bc737e936fed2a8c3d9381b9c201acce6dc0d6fffa0f8",
    ),
    "request_body_to_args": (
        request_body_to_args,
        "835056f4c3c8fceefa8cefa2916c514ccb1afb2a7b69ef0bc80b92ae624ac11f",
    ),
}


class _BoundedFormLeases:
    """Reserve one cleanup slot for every live multipart form."""

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._available = capacity
        self._lock = threading.Lock()

    def acquire(self) -> "_FormLease":
        with self._lock:
            if self._available == 0:
                raise BoundedExecutorOverloaded(
                    "Multipart form processing capacity is exhausted"
                )
            self._available -= 1
        return _FormLease(self)

    def release(self) -> None:
        with self._lock:
            if self._available >= self._capacity:
                raise RuntimeError("Multipart form lease released twice")
            self._available += 1


class _FormLease:
    """An idempotently releasable multipart form admission."""

    def __init__(self, owner: _BoundedFormLeases) -> None:
        self._owner = owner
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._owner.release()


_form_executor = BoundedExecutor(
    max_workers=_FORM_MAX_IN_FLIGHT,
    max_in_flight=_FORM_MAX_IN_FLIGHT,
    max_waiters=_FORM_MAX_WAITERS,
    thread_name_prefix="wegent-fastapi-form",
)
_form_cleanup_executor = BoundedExecutor(
    max_workers=_FORM_CLEANUP_WORKERS,
    max_in_flight=_FORM_MAX_IN_FLIGHT,
    max_waiters=0,
    thread_name_prefix="wegent-fastapi-form-cleanup",
)
_multipart_form_leases = _BoundedFormLeases(_FORM_MAX_IN_FLIGHT)


@lru_cache(maxsize=1)
def assert_fastapi_form_isolation_contract() -> None:
    """Fail startup if the adapted framework form implementation changed."""
    if fastapi.__version__ != SUPPORTED_FASTAPI_VERSION:
        raise RuntimeError(
            "FastAPI form isolation supports exactly "
            f"{SUPPORTED_FASTAPI_VERSION}; installed={fastapi.__version__}"
        )
    if starlette.__version__ != SUPPORTED_STARLETTE_VERSION:
        raise RuntimeError(
            "FastAPI form isolation supports exactly Starlette "
            f"{SUPPORTED_STARLETTE_VERSION}; installed={starlette.__version__}"
        )
    if python_multipart.__version__ != SUPPORTED_PYTHON_MULTIPART_VERSION:
        raise RuntimeError(
            "FastAPI form isolation supports exactly python-multipart "
            f"{SUPPORTED_PYTHON_MULTIPART_VERSION}; "
            f"installed={python_multipart.__version__}"
        )

    for name, (callable_obj, expected_hash) in _EXPECTED_SOURCE_HASHES.items():
        source_hash = hashlib.sha256(
            inspect.getsource(callable_obj).encode("utf-8")
        ).hexdigest()
        if source_hash != expected_hash:
            raise RuntimeError(
                f"FastAPI form isolation contract changed for {name}: "
                f"expected={expected_hash}, installed={source_hash}"
            )


def _call_in_form_executor(func: Callable[..., T], args: tuple[Any, ...]) -> T:
    token = _IN_FORM_EXECUTOR.set(True)
    try:
        return func(*args)
    finally:
        _IN_FORM_EXECUTOR.reset(token)


async def _run_form_sync(func: Callable[..., T], *args: Any) -> T:
    if _IN_FORM_EXECUTOR.get():
        return func(*args)
    return await run_bounded_to_completion(
        _form_executor,
        _call_in_form_executor,
        func,
        args,
    )


async def _run_form_cleanup_sync(func: Callable[..., T], *args: Any) -> T:
    if _IN_FORM_EXECUTOR.get():
        return func(*args)
    return await run_bounded_to_completion(
        _form_cleanup_executor,
        _call_in_form_executor,
        func,
        args,
    )


class IsolatedUploadFile(UploadFile):
    """UploadFile whose every filesystem operation uses an explicit executor."""

    def _write_sync(self, data: bytes) -> None:
        if self.size is not None:
            self.size += len(data)
        self.file.write(data)

    def _read_sync(self, size: int) -> bytes:
        return self.file.read(size)

    def _seek_sync(self, offset: int) -> None:
        self.file.seek(offset)

    def _close_sync(self) -> None:
        self.file.close()

    async def write(self, data: bytes) -> None:
        await _run_form_sync(self._write_sync, data)

    async def read(self, size: int = -1) -> bytes:
        return await _run_form_sync(self._read_sync, size)

    async def seek(self, offset: int) -> None:
        await _run_form_sync(self._seek_sync, offset)

    async def close(self) -> None:
        await _run_form_cleanup_sync(self._close_sync)


def _close_files_sync(files: tuple[BinaryIO, ...]) -> None:
    for file in files:
        file.close()


class IsolatedFormData(FormData):
    """FormData that batches file cleanup on reserved executor capacity."""

    def __init__(
        self,
        items: List[tuple[str, str | UploadFile]],
        *,
        lease: _FormLease,
    ) -> None:
        super().__init__(items)
        self._lease = lease
        self._close_claimed = False
        self._close_lock = threading.Lock()

    def _claim_close(self) -> bool:
        with self._close_lock:
            if self._close_claimed:
                return False
            self._close_claimed = True
            return True

    async def close(self) -> None:
        if not self._claim_close():
            return
        files = tuple(
            value.file
            for _, value in self.multi_items()
            if isinstance(value, UploadFile)
        )
        try:
            await _run_form_cleanup_sync(_close_files_sync, files)
        finally:
            self._lease.release()


class IsolatedMultiPartParser(MultiPartParser):
    """Starlette multipart callbacks driven by bounded synchronous steps."""

    def on_headers_finished(self) -> None:
        super().on_headers_finished()
        upload = self._current_part.file
        if upload is None:
            return
        self._current_part.file = IsolatedUploadFile(
            file=upload.file,
            size=upload.size,
            filename=upload.filename,
            headers=upload.headers,
        )

    async def parse_isolated(self, lease: _FormLease) -> IsolatedFormData:
        parser: PythonMultipartParser | None = None
        try:
            parser = await _run_form_sync(_initialize_multipart_sync, self)
            async for chunk in self.stream:
                await _run_form_sync(_feed_multipart_sync, self, parser, chunk)
            return await _run_form_sync(
                _finish_multipart_sync,
                self,
                parser,
                lease,
            )
        except BaseException:
            files = tuple(self._files_to_close_on_error)
            try:
                await _run_form_cleanup_sync(_close_files_sync, files)
            finally:
                lease.release()
            raise


def _initialize_multipart_sync(
    form_parser: IsolatedMultiPartParser,
) -> PythonMultipartParser:
    _, params = parse_options_header(form_parser.headers["Content-Type"])
    charset = params.get(b"charset", "utf-8")
    if isinstance(charset, bytes):
        charset = charset.decode("latin-1")
    form_parser._charset = charset
    try:
        boundary = params[b"boundary"]
    except KeyError as exc:
        raise MultiPartException("Missing boundary in multipart.") from exc

    callbacks: MultipartCallbacks = {
        "on_part_begin": form_parser.on_part_begin,
        "on_part_data": form_parser.on_part_data,
        "on_part_end": form_parser.on_part_end,
        "on_header_field": form_parser.on_header_field,
        "on_header_value": form_parser.on_header_value,
        "on_header_end": form_parser.on_header_end,
        "on_headers_finished": form_parser.on_headers_finished,
        "on_end": form_parser.on_end,
    }
    return PythonMultipartParser(boundary, callbacks)


def _feed_multipart_sync(
    form_parser: IsolatedMultiPartParser,
    parser: PythonMultipartParser,
    chunk: bytes,
) -> None:
    parser.write(chunk)
    for part, data in form_parser._file_parts_to_write:
        upload = part.file
        assert isinstance(upload, IsolatedUploadFile)
        upload._write_sync(data)
    for part in form_parser._file_parts_to_finish:
        upload = part.file
        assert isinstance(upload, IsolatedUploadFile)
        upload._seek_sync(0)
    form_parser._file_parts_to_write.clear()
    form_parser._file_parts_to_finish.clear()


def _finish_multipart_sync(
    form_parser: IsolatedMultiPartParser,
    parser: PythonMultipartParser,
    lease: _FormLease,
) -> IsolatedFormData:
    parser.finalize()
    return IsolatedFormData(form_parser.items, lease=lease)


@dataclass
class _UrlEncodedState:
    parser: QuerystringParser
    field_name: bytes
    field_value: bytes
    items: List[tuple[str, str | UploadFile]]


def _initialize_urlencoded_sync(form_parser: FormParser) -> _UrlEncodedState:
    callbacks: QuerystringCallbacks = {
        "on_field_start": form_parser.on_field_start,
        "on_field_name": form_parser.on_field_name,
        "on_field_data": form_parser.on_field_data,
        "on_field_end": form_parser.on_field_end,
        "on_end": form_parser.on_end,
    }
    return _UrlEncodedState(
        parser=QuerystringParser(callbacks),
        field_name=b"",
        field_value=b"",
        items=[],
    )


def _feed_urlencoded_sync(
    form_parser: FormParser,
    state: _UrlEncodedState,
    chunk: bytes,
) -> None:
    if chunk:
        state.parser.write(chunk)
    else:
        state.parser.finalize()
    messages = list(form_parser.messages)
    form_parser.messages.clear()
    for message_type, message_bytes in messages:
        if message_type == FormMessage.FIELD_START:
            state.field_name = b""
            state.field_value = b""
        elif message_type == FormMessage.FIELD_NAME:
            state.field_name += message_bytes
        elif message_type == FormMessage.FIELD_DATA:
            state.field_value += message_bytes
        elif message_type == FormMessage.FIELD_END:
            name = unquote_plus(state.field_name.decode("latin-1"))
            value = unquote_plus(state.field_value.decode("latin-1"))
            state.items.append((name, value))


async def _parse_urlencoded(
    headers: Headers,
    stream: AsyncGenerator[bytes, None],
) -> FormData:
    form_parser = await _run_form_sync(FormParser, headers, stream)
    state = await _run_form_sync(_initialize_urlencoded_sync, form_parser)
    async for chunk in stream:
        await _run_form_sync(_feed_urlencoded_sync, form_parser, state, chunk)
    return await _run_form_sync(FormData, state.items)


def _parse_content_type_sync(content_type_header: str | None) -> bytes:
    content_type, _ = parse_options_header(content_type_header)
    return content_type


def _create_multipart_parser_sync(
    headers: Headers,
    stream: AsyncGenerator[bytes, None],
    max_files: int | float,
    max_fields: int | float,
    max_part_size: int,
) -> IsolatedMultiPartParser:
    return IsolatedMultiPartParser(
        headers,
        stream,
        max_files=max_files,
        max_fields=max_fields,
        max_part_size=max_part_size,
    )


class IsolatedRequest(Request):
    """Request whose form parser cannot execute synchronous work on its loop."""

    async def _get_form(
        self,
        *,
        max_files: int | float = 1000,
        max_fields: int | float = 1000,
        max_part_size: int = 1024 * 1024,
    ) -> FormData:
        if self._form is None:
            content_type_header = self.headers.get("Content-Type")
            content_type = await _run_form_sync(
                _parse_content_type_sync,
                content_type_header,
            )
            if content_type == b"multipart/form-data":
                lease = _multipart_form_leases.acquire()
                try:
                    parser = await _run_form_sync(
                        _create_multipart_parser_sync,
                        self.headers,
                        self.stream(),
                        max_files,
                        max_fields,
                        max_part_size,
                    )
                    self._form = await parser.parse_isolated(lease)
                except MultiPartException as exc:
                    if "app" in self.scope:
                        raise HTTPException(
                            status_code=400,
                            detail=exc.message,
                        ) from exc
                    raise
                except BaseException:
                    lease.release()
                    raise
                self._register_form_cleanup(self._form)
            elif content_type == b"application/x-www-form-urlencoded":
                self._form = await _parse_urlencoded(
                    self.headers,
                    self.stream(),
                )
            else:
                self._form = await _run_form_sync(FormData)
        return self._form

    def _register_form_cleanup(self, form: FormData) -> None:
        stack = self.scope.get("fastapi_middleware_astack")
        if isinstance(stack, AsyncExitStack):
            stack.push_async_callback(form.close)


def _request_body_to_args_sync(
    body_fields: List[ModelField],
    received_body: FormData,
    embed_body_fields: bool,
) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
    return asyncio.run(
        request_body_to_args(
            body_fields=body_fields,
            received_body=received_body,
            embed_body_fields=embed_body_fields,
        )
    )


async def run_form_body_to_args(
    body_fields: List[ModelField],
    received_body: FormData,
    embed_body_fields: bool,
) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Extract and validate a FastAPI form body on the bounded form executor."""
    return await _run_form_sync(
        _request_body_to_args_sync,
        body_fields,
        received_body,
        embed_body_fields,
    )
