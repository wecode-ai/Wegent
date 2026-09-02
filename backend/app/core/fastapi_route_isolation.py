# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep FastAPI's synchronous request work off the Uvicorn event loop.

FastAPI does not currently expose hooks around request-field validation or
automatic response serialization.  This module is the single, version-locked
adapter for those internals.  Payload codecs, synchronous dependencies,
synchronous dependency context managers, and synchronous endpoints all use
explicit Wegent-owned bounded executors. ASGI response delivery remains on the
Uvicorn event loop.
"""

from __future__ import annotations

import asyncio
import email.message
import hashlib
import inspect
import json
import threading
from contextlib import (
    AbstractContextManager,
    AsyncExitStack,
    asynccontextmanager,
    contextmanager,
)
from dataclasses import dataclass
from functools import lru_cache
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    List,
    Optional,
    Type,
    TypeVar,
    Union,
    cast,
)

import fastapi
import starlette
from fastapi import BackgroundTasks, FastAPI, params, temp_pydantic_v1_params
from fastapi._compat import ModelField, _normalize_errors
from fastapi.concurrency import (
    contextmanager_in_threadpool as fastapi_contextmanager_in_threadpool,
)
from fastapi.datastructures import Default, DefaultPlaceholder
from fastapi.dependencies import utils as fastapi_dependency_utils
from fastapi.dependencies.models import Dependant
from fastapi.dependencies.utils import (
    SolvedDependency,
)
from fastapi.dependencies.utils import _solve_generator as fastapi_solve_generator
from fastapi.dependencies.utils import (
    get_dependant,
    request_body_to_args,
    request_params_to_args,
)
from fastapi.exceptions import EndpointContext, FastAPIError, RequestValidationError
from fastapi.routing import (
    APIRoute,
    _extract_endpoint_context,
)
from fastapi.routing import get_request_handler as fastapi_get_request_handler
from fastapi.routing import request_response as starlette_request_response
from fastapi.routing import run_endpoint_function as fastapi_run_endpoint_function
from fastapi.routing import (
    serialize_response,
)
from fastapi.security.oauth2 import SecurityScopes
from fastapi.types import DependencyCacheKey, IncEx
from fastapi.utils import is_body_allowed_for_status_code
from starlette._exception_handler import wrap_app_handling_exceptions
from starlette.background import BackgroundTasks as StarletteBackgroundTasks
from starlette.datastructures import FormData
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket

from app.core.bounded_executor import (
    BoundedExecutor,
    BoundedExecutorOverloaded,
    run_bounded_to_completion,
    wait_without_abandoning,
)
from app.core.config import settings
from app.core.fastapi_form_isolation import (
    IsolatedRequest,
    assert_fastapi_form_isolation_contract,
    run_form_body_to_args,
)
from app.core.fastapi_response_isolation import (
    assert_fastapi_response_isolation_contract,
    prepare_response_execution,
)
from app.core.payload_codec import run_payload_codec

T = TypeVar("T")

SUPPORTED_FASTAPI_VERSION = "0.124.0"
SUPPORTED_STARLETTE_VERSION = "0.50.0"
_ISOLATED_ROUTE_MARKER = "_wegent_payload_isolated"
_SYNC_WEB_MAX_WORKERS = 32
_SYNC_WEB_MAX_IN_FLIGHT = 32
_SYNC_WEB_MAX_WAITERS = 128
_SYNC_DEPENDENCY_CONTEXT_CAPACITY = settings.WEB_MAX_CONCURRENCY
_SYNC_DEPENDENCY_CLEANUP_WORKERS = min(4, _SYNC_DEPENDENCY_CONTEXT_CAPACITY)
_EXPECTED_SOURCE_HASHES: Dict[str, tuple[Callable[..., Any], str]] = {
    "APIRoute.get_route_handler": (
        APIRoute.get_route_handler,
        "f0870f89e639bbeee3a454c8ce17ed4a85392c2dca1d1258e7f0e4f894e3443e",
    ),
    "get_request_handler": (
        fastapi_get_request_handler,
        "c96955e189f7e668d09a1b8e7ae900616cc03b80bf5c51050fd3ef1dfbda67ee",
    ),
    "request_response": (
        starlette_request_response,
        "a9e198c8cc21bb1f83df7128e292323fcff40ba6148d112a7dcea0646685f79b",
    ),
    "serialize_response": (
        serialize_response,
        "83efc4636110c79db60d00fc7e84a20b99f953b06d38d9242e6c8d3b6b72ad6c",
    ),
    "solve_dependencies": (
        fastapi_dependency_utils.solve_dependencies,
        "09b8f616a9d30afc0fc324ffbe28d6a306f94f8cff382025410e18bc4be27f63",
    ),
    "_solve_generator": (
        fastapi_solve_generator,
        "14a409c7df31e69ff93d67ad05b5dae7a2b8f03c21bca3d21492ab7be78397f5",
    ),
    "contextmanager_in_threadpool": (
        fastapi_contextmanager_in_threadpool,
        "90ed6d0da0b040fde810c27a59d833595fd8c09d1e8cae9d3a8dcf556109b904",
    ),
    "run_endpoint_function": (
        fastapi_run_endpoint_function,
        "547a6d7929c2c351a65c52a28f9e4f0a25257d8c84ba05e08415c88234c2b17e",
    ),
    "Request.json": (
        Request.json,
        "49b2c23705a41dece62c58cb00deb100394b20aebb041b288af28aa038c6995e",
    ),
}


class _BoundedContextLeases:
    """Reserve cleanup capacity for every entered sync dependency context."""

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._available = capacity
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            if self._available == 0:
                raise BoundedExecutorOverloaded(
                    "Synchronous dependency context capacity is exhausted"
                )
            self._available -= 1

    def release(self) -> None:
        with self._lock:
            if self._available >= self._capacity:
                raise RuntimeError("Dependency context lease released twice")
            self._available += 1


_sync_web_executor = BoundedExecutor(
    max_workers=_SYNC_WEB_MAX_WORKERS,
    max_in_flight=_SYNC_WEB_MAX_IN_FLIGHT,
    max_waiters=_SYNC_WEB_MAX_WAITERS,
    thread_name_prefix="wegent-fastapi-sync",
)
_sync_dependency_cleanup_executor = BoundedExecutor(
    max_workers=_SYNC_DEPENDENCY_CLEANUP_WORKERS,
    max_in_flight=_SYNC_DEPENDENCY_CONTEXT_CAPACITY,
    max_waiters=0,
    thread_name_prefix="wegent-fastapi-dependency-cleanup",
)
_sync_dependency_context_leases = _BoundedContextLeases(
    _SYNC_DEPENDENCY_CONTEXT_CAPACITY
)


@dataclass(frozen=True)
class _AutomaticResponseSpec:
    response_field: Optional[ModelField]
    raw_response: Any
    response_class: Type[Response]
    response_args: Dict[str, Any]
    include: Optional[IncEx]
    exclude: Optional[IncEx]
    by_alias: bool
    exclude_unset: bool
    exclude_defaults: bool
    exclude_none: bool
    endpoint_ctx: EndpointContext


@lru_cache(maxsize=1)
def assert_fastapi_route_isolation_contract() -> None:
    """Fail startup when the private adapter no longer matches installed code."""
    if fastapi.__version__ != SUPPORTED_FASTAPI_VERSION:
        raise RuntimeError(
            "FastAPI route isolation supports exactly "
            f"{SUPPORTED_FASTAPI_VERSION}; installed={fastapi.__version__}"
        )
    if starlette.__version__ != SUPPORTED_STARLETTE_VERSION:
        raise RuntimeError(
            "FastAPI route isolation supports exactly Starlette "
            f"{SUPPORTED_STARLETTE_VERSION}; installed={starlette.__version__}"
        )
    assert_fastapi_form_isolation_contract()
    assert_fastapi_response_isolation_contract()

    for name, (callable_obj, expected_hash) in _EXPECTED_SOURCE_HASHES.items():
        source_hash = hashlib.sha256(
            inspect.getsource(callable_obj).encode("utf-8")
        ).hexdigest()
        if source_hash != expected_hash:
            raise RuntimeError(
                f"FastAPI route isolation contract changed for {name}: "
                f"expected={expected_hash}, installed={source_hash}"
            )


def _decode_json_sync(body: bytes) -> Any:
    return json.loads(body)


def _request_params_sync(
    dependant: Dependant,
    request: Union[Request, WebSocket],
) -> tuple[
    tuple[Dict[str, Any], List[Any]],
    tuple[Dict[str, Any], List[Any]],
    tuple[Dict[str, Any], List[Any]],
    tuple[Dict[str, Any], List[Any]],
]:
    return (
        request_params_to_args(dependant.path_params, request.path_params),
        request_params_to_args(dependant.query_params, request.query_params),
        request_params_to_args(dependant.header_params, request.headers),
        request_params_to_args(dependant.cookie_params, request.cookies),
    )


def _request_body_to_args_sync(
    body_fields: List[ModelField],
    received_body: Any,
    embed_body_fields: bool,
) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
    return asyncio.run(
        request_body_to_args(
            body_fields=body_fields,
            received_body=received_body,
            embed_body_fields=embed_body_fields,
        )
    )


def _normalize_errors_sync(errors: List[Any]) -> List[Dict[str, Any]]:
    return _normalize_errors(errors)


def _invoke_with_values(
    call: Callable[..., T],
    values: Dict[str, Any],
) -> T:
    return call(**values)


async def _run_sync_web_callable(
    call: Callable[..., T],
    values: Dict[str, Any],
) -> T:
    return await run_bounded_to_completion(
        _sync_web_executor,
        _invoke_with_values,
        call,
        values,
    )


async def _exit_sync_dependency_context(
    cm: AbstractContextManager[Any],
    exc_type: Optional[Type[BaseException]],
    exc: Optional[BaseException],
    traceback: Any,
) -> bool:
    result = await run_bounded_to_completion(
        _sync_dependency_cleanup_executor,
        cm.__exit__,
        exc_type,
        exc,
        traceback,
    )
    return bool(result)


async def _enter_sync_dependency_context(
    cm: AbstractContextManager[T],
) -> T:
    task, cancellation = await wait_without_abandoning(
        _sync_web_executor.run(cm.__enter__)
    )
    try:
        value = task.result()
    except BaseException as exc:
        if cancellation is not None:
            raise cancellation from exc
        raise
    if cancellation is not None:
        await _exit_sync_dependency_context(
            cm,
            type(cancellation),
            cancellation,
            cancellation.__traceback__,
        )
        raise cancellation
    return value


@asynccontextmanager
async def _bounded_sync_dependency_context(
    cm: AbstractContextManager[T],
) -> AsyncIterator[T]:
    _sync_dependency_context_leases.acquire()
    try:
        value = await _enter_sync_dependency_context(cm)
        try:
            yield value
        except BaseException as exc:
            suppress = await _exit_sync_dependency_context(
                cm,
                type(exc),
                exc,
                exc.__traceback__,
            )
            if not suppress:
                raise
        else:
            await _exit_sync_dependency_context(cm, None, None, None)
    finally:
        _sync_dependency_context_leases.release()


async def _solve_isolated_generator(
    *,
    dependant: Dependant,
    stack: AsyncExitStack,
    sub_values: Dict[str, Any],
) -> Any:
    assert dependant.call is not None
    if dependant.is_async_gen_callable:
        cm = asynccontextmanager(dependant.call)(**sub_values)
    else:
        sync_cm = contextmanager(dependant.call)(**sub_values)
        cm = _bounded_sync_dependency_context(sync_cm)
    return await stack.enter_async_context(cm)


def _build_automatic_response_sync(spec: _AutomaticResponseSpec) -> Response:
    content = asyncio.run(
        serialize_response(
            field=spec.response_field,
            response_content=spec.raw_response,
            include=spec.include,
            exclude=spec.exclude,
            by_alias=spec.by_alias,
            exclude_unset=spec.exclude_unset,
            exclude_defaults=spec.exclude_defaults,
            exclude_none=spec.exclude_none,
            # Validation is already running in a dedicated codec worker.
            is_coroutine=True,
            endpoint_ctx=spec.endpoint_ctx,
        )
    )
    response = spec.response_class(content, **spec.response_args)
    if not is_body_allowed_for_status_code(response.status_code):
        response.body = b""
    return response


async def _read_request_body(
    request: Request,
    *,
    is_body_form: bool,
    endpoint_ctx: EndpointContext,
) -> Any:
    try:
        if is_body_form:
            return await request.form()

        body_bytes = await request.body()
        if not body_bytes:
            return None
        if not _request_body_is_json(request):
            return body_bytes

        json_body = await run_payload_codec(
            _decode_json_sync,
            body_bytes,
            payload_hint=body_bytes,
            force_offload=True,
        )
        # Preserve Starlette's request.json() cache so endpoint code cannot
        # decode the same body again on the Uvicorn loop.
        request._json = json_body  # type: ignore[attr-defined]
        return json_body
    except json.JSONDecodeError as exc:
        raise RequestValidationError(
            [
                {
                    "type": "json_invalid",
                    "loc": ("body", exc.pos),
                    "msg": "JSON decode error",
                    "input": {},
                    "ctx": {"error": exc.msg},
                }
            ],
            body=exc.doc,
            endpoint_ctx=endpoint_ctx,
        ) from exc
    except HTTPException:
        raise
    except BoundedExecutorOverloaded:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="There was an error parsing the body",
        ) from exc


def _request_body_is_json(request: Request) -> bool:
    content_type_value = request.headers.get("content-type")
    if not content_type_value:
        return True
    message = email.message.Message()
    message["content-type"] = content_type_value
    if message.get_content_maintype() != "application":
        return False
    subtype = message.get_content_subtype()
    return subtype == "json" or subtype.endswith("+json")


async def _isolated_solve_dependencies(
    *,
    request: Union[Request, WebSocket],
    dependant: Dependant,
    body: Any = None,
    background_tasks: Optional[StarletteBackgroundTasks] = None,
    response: Optional[Response] = None,
    dependency_overrides_provider: Optional[Any] = None,
    dependency_cache: Optional[Dict[DependencyCacheKey, Any]] = None,
    async_exit_stack: AsyncExitStack,
    embed_body_fields: bool,
) -> SolvedDependency:
    """FastAPI 0.124 solve_dependencies with bounded validation phases."""
    request_astack = request.scope.get("fastapi_inner_astack")
    assert isinstance(
        request_astack, AsyncExitStack
    ), "fastapi_inner_astack not found in request scope"
    function_astack = request.scope.get("fastapi_function_astack")
    assert isinstance(
        function_astack, AsyncExitStack
    ), "fastapi_function_astack not found in request scope"
    values: Dict[str, Any] = {}
    errors: List[Any] = []
    if response is None:
        response = Response()
        del response.headers["content-length"]
        response.status_code = None  # type: ignore[assignment]
    if dependency_cache is None:
        dependency_cache = {}

    for sub_dependant in dependant.dependencies:
        sub_dependant.call = cast(Callable[..., Any], sub_dependant.call)
        call = sub_dependant.call
        use_sub_dependant = sub_dependant
        if (
            dependency_overrides_provider
            and dependency_overrides_provider.dependency_overrides
        ):
            original_call = sub_dependant.call
            call = getattr(
                dependency_overrides_provider, "dependency_overrides", {}
            ).get(original_call, original_call)
            use_sub_dependant = get_dependant(
                path=sub_dependant.path,  # type: ignore[arg-type]
                call=call,
                name=sub_dependant.name,
                parent_oauth_scopes=sub_dependant.oauth_scopes,
                scope=sub_dependant.scope,
            )

        solved_result = await _isolated_solve_dependencies(
            request=request,
            dependant=use_sub_dependant,
            body=body,
            background_tasks=background_tasks,
            response=response,
            dependency_overrides_provider=dependency_overrides_provider,
            dependency_cache=dependency_cache,
            async_exit_stack=async_exit_stack,
            embed_body_fields=embed_body_fields,
        )
        background_tasks = solved_result.background_tasks
        if solved_result.errors:
            errors.extend(solved_result.errors)
            continue
        if sub_dependant.use_cache and sub_dependant.cache_key in dependency_cache:
            solved = dependency_cache[sub_dependant.cache_key]
        elif (
            use_sub_dependant.is_gen_callable or use_sub_dependant.is_async_gen_callable
        ):
            use_astack = request_astack
            if sub_dependant.scope == "function":
                use_astack = function_astack
            solved = await _solve_isolated_generator(
                dependant=use_sub_dependant,
                stack=use_astack,
                sub_values=solved_result.values,
            )
        elif use_sub_dependant.is_coroutine_callable:
            solved = await call(**solved_result.values)
        else:
            solved = await _run_sync_web_callable(call, solved_result.values)
        if sub_dependant.name is not None:
            values[sub_dependant.name] = solved
        if sub_dependant.cache_key not in dependency_cache:
            dependency_cache[sub_dependant.cache_key] = solved

    param_results = await run_payload_codec(
        _request_params_sync,
        dependant,
        request,
        payload_hint=(
            request.path_params,
            request.query_params,
            request.headers,
            request.cookies,
        ),
        force_offload=True,
    )
    (
        (path_values, path_errors),
        (query_values, query_errors),
        (
            header_values,
            header_errors,
        ),
        (cookie_values, cookie_errors),
    ) = param_results
    values.update(path_values)
    values.update(query_values)
    values.update(header_values)
    values.update(cookie_values)
    errors += path_errors + query_errors + header_errors + cookie_errors

    if dependant.body_params:
        if isinstance(body, FormData):
            body_values, body_errors = await run_form_body_to_args(
                dependant.body_params,
                body,
                embed_body_fields,
            )
        else:
            body_values, body_errors = await run_payload_codec(
                _request_body_to_args_sync,
                dependant.body_params,
                body,
                embed_body_fields,
                payload_hint=body,
                force_offload=True,
            )
        values.update(body_values)
        errors.extend(body_errors)

    if dependant.http_connection_param_name:
        values[dependant.http_connection_param_name] = request
    if dependant.request_param_name and isinstance(request, Request):
        values[dependant.request_param_name] = request
    elif dependant.websocket_param_name and isinstance(request, WebSocket):
        values[dependant.websocket_param_name] = request
    if dependant.background_tasks_param_name:
        if background_tasks is None:
            background_tasks = BackgroundTasks()
        values[dependant.background_tasks_param_name] = background_tasks
    if dependant.response_param_name:
        values[dependant.response_param_name] = response
    if dependant.security_scopes_param_name:
        values[dependant.security_scopes_param_name] = SecurityScopes(
            scopes=dependant.oauth_scopes
        )
    return SolvedDependency(
        values=values,
        errors=errors,
        background_tasks=background_tasks,
        response=response,
        dependency_cache=dependency_cache,
    )


def get_isolated_request_handler(
    dependant: Dependant,
    body_field: Optional[ModelField] = None,
    status_code: Optional[int] = None,
    response_class: Union[Type[Response], DefaultPlaceholder] = Default(JSONResponse),
    response_field: Optional[ModelField] = None,
    response_model_include: Optional[IncEx] = None,
    response_model_exclude: Optional[IncEx] = None,
    response_model_by_alias: bool = True,
    response_model_exclude_unset: bool = False,
    response_model_exclude_defaults: bool = False,
    response_model_exclude_none: bool = False,
    dependency_overrides_provider: Optional[Any] = None,
    embed_body_fields: bool = False,
) -> Callable[[Request], Coroutine[Any, Any, Response]]:
    """Build the version-locked request handler used by isolated routes."""
    assert_fastapi_route_isolation_contract()
    assert dependant.call is not None, "dependant.call must be a function"
    endpoint_call = dependant.call
    is_coroutine = dependant.is_coroutine_callable
    is_body_form = bool(
        body_field
        and isinstance(
            body_field.field_info,
            (params.Form, temp_pydantic_v1_params.Form),
        )
    )
    actual_response_class = (
        response_class.value
        if isinstance(response_class, DefaultPlaceholder)
        else response_class
    )

    async def app(request: Request) -> Response:
        response: Optional[Response] = None
        file_stack = request.scope.get("fastapi_middleware_astack")
        assert isinstance(
            file_stack, AsyncExitStack
        ), "fastapi_middleware_astack not found in request scope"
        endpoint_ctx = _extract_endpoint_context(endpoint_call)
        if dependant.path:
            mount_path = request.scope.get("root_path", "").rstrip("/")
            endpoint_ctx["path"] = f"{request.method} {mount_path}{dependant.path}"

        body: Any = None
        if body_field:
            body = await _read_request_body(
                request,
                is_body_form=is_body_form,
                endpoint_ctx=endpoint_ctx,
            )

        async_exit_stack = request.scope.get("fastapi_inner_astack")
        assert isinstance(
            async_exit_stack, AsyncExitStack
        ), "fastapi_inner_astack not found in request scope"
        solved_result = await _isolated_solve_dependencies(
            request=request,
            dependant=dependant,
            body=body,
            dependency_overrides_provider=dependency_overrides_provider,
            async_exit_stack=async_exit_stack,
            embed_body_fields=embed_body_fields,
        )
        if not solved_result.errors:
            if is_coroutine:
                raw_response = await endpoint_call(**solved_result.values)
            else:
                raw_response = await _run_sync_web_callable(
                    endpoint_call,
                    solved_result.values,
                )
            if isinstance(raw_response, Response):
                if raw_response.background is None:
                    raw_response.background = solved_result.background_tasks
                response = raw_response
            else:
                response_args: Dict[str, Any] = {
                    "background": solved_result.background_tasks
                }
                current_status_code = (
                    status_code if status_code else solved_result.response.status_code
                )
                if current_status_code is not None:
                    response_args["status_code"] = current_status_code
                if solved_result.response.status_code:
                    response_args["status_code"] = solved_result.response.status_code
                response = await run_payload_codec(
                    _build_automatic_response_sync,
                    _AutomaticResponseSpec(
                        response_field=response_field,
                        raw_response=raw_response,
                        response_class=actual_response_class,
                        response_args=response_args,
                        include=response_model_include,
                        exclude=response_model_exclude,
                        by_alias=response_model_by_alias,
                        exclude_unset=response_model_exclude_unset,
                        exclude_defaults=response_model_exclude_defaults,
                        exclude_none=response_model_exclude_none,
                        endpoint_ctx=endpoint_ctx,
                    ),
                    payload_hint=raw_response,
                    force_offload=True,
                )
                response.headers.raw.extend(solved_result.response.headers.raw)
        if solved_result.errors:
            normalized_errors = await run_payload_codec(
                _normalize_errors_sync,
                solved_result.errors,
                payload_hint=solved_result.errors,
                force_offload=True,
            )
            raise RequestValidationError(
                normalized_errors,
                body=body,
                endpoint_ctx=endpoint_ctx,
            )
        assert response
        return response

    setattr(app, _ISOLATED_ROUTE_MARKER, True)
    return app


def _isolated_handler_for_route(route: APIRoute) -> Callable[..., Any]:
    return get_isolated_request_handler(
        dependant=route.dependant,
        body_field=route.body_field,
        status_code=route.status_code,
        response_class=route.response_class,
        response_field=route.secure_cloned_response_field,
        response_model_include=route.response_model_include,
        response_model_exclude=route.response_model_exclude,
        response_model_by_alias=route.response_model_by_alias,
        response_model_exclude_unset=route.response_model_exclude_unset,
        response_model_exclude_defaults=route.response_model_exclude_defaults,
        response_model_exclude_none=route.response_model_exclude_none,
        dependency_overrides_provider=route.dependency_overrides_provider,
        embed_body_fields=route._embed_body_fields,
    )


class IsolatedAPIRoute(APIRoute):
    """APIRoute whose automatic payload codecs use bounded workers."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.app = _isolated_request_response(self.get_route_handler())

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = _isolated_handler_for_route(self)
        setattr(self, _ISOLATED_ROUTE_MARKER, True)
        return handler


def _isolated_request_response(
    func: Callable[[Request], Awaitable[Response]],
) -> ASGIApp:
    """Starlette request_response with Wegent's version-locked Request type."""

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        request = IsolatedRequest(scope, receive, send)

        async def route_app(
            _scope: Scope,
            _receive: Receive,
            response_send: Send,
        ) -> None:
            response_awaited = False
            async with AsyncExitStack() as request_stack:
                scope["fastapi_inner_astack"] = request_stack
                async with AsyncExitStack() as function_stack:
                    scope["fastapi_function_astack"] = function_stack
                    response = await func(request)
                execution = prepare_response_execution(response)
                try:
                    await response(scope, receive, response_send)
                    response_awaited = True
                finally:
                    await execution.finalize()
            if not response_awaited:
                raise FastAPIError(
                    "Response not awaited. There's a high chance that the "
                    "application code is raising an exception and a dependency "
                    "with yield has a block with a bare except, or a block with "
                    "except Exception, and is not raising the exception again. "
                    "Read more about it in the docs: "
                    "https://fastapi.tiangolo.com/tutorial/dependencies/"
                    "dependencies-with-yield/#dependencies-with-yield-and-except"
                )

        await wrap_app_handling_exceptions(route_app, request)(scope, receive, send)

    return app


def _install_router_routes(routes: List[Any]) -> None:
    for route in routes:
        if isinstance(route, APIRoute):
            if not route_has_payload_isolation(route):
                route.app = _isolated_request_response(
                    _isolated_handler_for_route(route)
                )
                setattr(route, _ISOLATED_ROUTE_MARKER, True)
        if isinstance(route, Mount):
            mounted_routes = getattr(route, "routes", None)
            if isinstance(mounted_routes, list):
                _install_router_routes(mounted_routes)
            mounted_router = getattr(route.app, "router", None)
            if mounted_router is not None and hasattr(mounted_router, "route_class"):
                mounted_router.route_class = IsolatedAPIRoute


def install_fastapi_route_isolation(app: FastAPI) -> None:
    """Install isolated handlers for existing and subsequently added API routes."""
    assert_fastapi_route_isolation_contract()
    app.router.route_class = IsolatedAPIRoute
    _install_router_routes(app.routes)
    app.state.fastapi_route_isolation_installed = True


def route_has_payload_isolation(route: APIRoute) -> bool:
    """Return whether a route is protected by the isolated request handler."""
    return bool(getattr(route, _ISOLATED_ROUTE_MARKER, False))
