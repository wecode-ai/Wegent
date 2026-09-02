# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Static invariants for the sole Uvicorn event loop.

Runtime fault-injection tests prove individual boundaries. This AST guard keeps
new direct synchronous database, network, process, or implicit-executor calls
from silently returning to async code.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

APP_ROOT = Path(__file__).parents[2] / "app"
WEB_HANDLER_ROOTS = (
    APP_ROOT / "api" / "endpoints",
    APP_ROOT / "api" / "ws",
)
_BLOCKING_CALLS = {
    "app.core.distributed_lock.distributed_lock.acquire",
    "app.core.distributed_lock.distributed_lock.acquire_context",
    "app.core.distributed_lock.distributed_lock.acquire_watchdog_context",
    "app.core.distributed_lock.distributed_lock.extend",
    "app.core.distributed_lock.distributed_lock.is_locked",
    "app.core.distributed_lock.distributed_lock.release",
    "app.db.session.get_db_session",
    "app.db.session.SessionLocal",
    "copy.copy",
    "copy.deepcopy",
    "dataclasses.asdict",
    "open",
    "os.listdir",
    "os.makedirs",
    "os.mkdir",
    "os.remove",
    "os.rename",
    "os.replace",
    "os.scandir",
    "os.stat",
    "os.unlink",
    "os.walk",
    "os.path.exists",
    "os.path.getsize",
    "os.path.isdir",
    "os.path.isfile",
    "redis.Redis",
    "redis.Redis.from_url",
    "redis.from_url",
    "requests.delete",
    "requests.get",
    "requests.head",
    "requests.options",
    "requests.patch",
    "requests.post",
    "requests.put",
    "requests.request",
    "socketio.RedisManager",
    "socket.getaddrinfo",
    "subprocess.call",
    "subprocess.check_call",
    "subprocess.check_output",
    "subprocess.Popen",
    "subprocess.run",
    "shutil.copy",
    "shutil.copy2",
    "shutil.copyfile",
    "shutil.copytree",
    "shutil.move",
    "shutil.rmtree",
    "tempfile.mkdtemp",
    "tempfile.mkstemp",
    "tempfile.NamedTemporaryFile",
    "tempfile.TemporaryDirectory",
    "time.sleep",
    "urllib.request.urlopen",
    "app.services.plugin_release_notification_service.emit_plugin_release_available",
    "app.services.plugin_release_notification_service.notify_plugin_release_available",
    "app.services.project_chat.push.push_project_chat_message",
}
_IMPLICIT_EXECUTOR_CALLS = {
    "asyncio.to_thread",
    "fastapi.concurrency.run_in_threadpool",
    "starlette.concurrency.run_in_threadpool",
}
# Lifespan executes before Uvicorn accepts traffic. Its distributed startup lock,
# migration check, and idempotent bootstrap are intentionally synchronous and do
# not share the serving loop with requests.
_PRE_BIND_ALLOWLIST = {
    ("app/main.py", "lifespan"),
    # Socket preparation happens before start_unix_server accepts traffic and
    # cleanup happens only after the stream server has closed and drained.
    ("app/stream_worker.py", "run"),
}
_SYNC_SESSION_TYPE = "sqlalchemy.orm.Session"
_SYNC_SESSION_DEPENDENCIES = {
    "app.api.dependencies.get_db",
    "app.db.session.get_wiki_db",
}
_DIRECT_CODEC_CALLS = {
    "json.dump",
    "json.dumps",
    "json.load",
    "json.loads",
    "orjson.dumps",
    "orjson.loads",
    "ujson.dumps",
    "ujson.loads",
    "yaml.dump",
    "yaml.load",
    "yaml.safe_dump",
    "yaml.safe_load",
}
_HTTP_METHODS = {"delete", "get", "patch", "post", "put", "request", "send"}
_FILESYSTEM_METHODS = {
    "glob",
    "iterdir",
    "mkdir",
    "read_bytes",
    "read_text",
    "rglob",
    "stat",
    "touch",
    "unlink",
    "write_bytes",
    "write_text",
}


@dataclass(frozen=True)
class _Violation:
    path: str
    function: str
    line: int
    call: str

    def render(self) -> str:
        return f"{self.path}:{self.line} {self.function} -> {self.call}"


def _dotted_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def _import_aliases(tree: ast.Module) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for value in node.names:
                local_name = value.asname or value.name.split(".")[0]
                aliases[local_name] = value.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for value in node.names:
                local_name = value.asname or value.name
                aliases[local_name] = f"{node.module}.{value.name}"
    return aliases


def _resolve_call_name(call: ast.Call, aliases: dict[str, str]) -> str:
    dotted = _dotted_name(call.func)
    root, separator, suffix = dotted.partition(".")
    resolved_root = aliases.get(root, root)
    return f"{resolved_root}.{suffix}" if separator else resolved_root


def _resolve_name(node: ast.expr, aliases: dict[str, str]) -> str:
    dotted = _dotted_name(node)
    root, separator, suffix = dotted.partition(".")
    resolved_root = aliases.get(root, root)
    return f"{resolved_root}.{suffix}" if separator else resolved_root


def _annotation_has_sync_session(
    annotation: ast.expr | None,
    aliases: dict[str, str],
) -> bool:
    if annotation is None:
        return False
    return any(
        _resolve_name(node, aliases) == _SYNC_SESSION_TYPE
        for node in ast.walk(annotation)
        if isinstance(node, (ast.Name, ast.Attribute))
    )


def _depends_on_sync_session(
    expression: ast.expr | None,
    aliases: dict[str, str],
) -> bool:
    if expression is None:
        return False
    for node in ast.walk(expression):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        dependency_factory = _resolve_call_name(node, aliases)
        if (
            not dependency_factory.endswith(".Depends")
            and dependency_factory != "Depends"
        ):
            continue
        if _resolve_name(node.args[0], aliases) in _SYNC_SESSION_DEPENDENCIES:
            return True
    return False


def _sync_session_violations(path: Path) -> list[_Violation]:
    relative_path = path.relative_to(APP_ROOT.parent).as_posix()
    tree = ast.parse(path.read_text(), filename=str(path))
    aliases = _import_aliases(tree)
    violations: list[_Violation] = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        arguments = [
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
        ]
        defaults: list[ast.expr | None] = [
            *(
                [None]
                * (
                    len(node.args.posonlyargs)
                    + len(node.args.args)
                    - len(node.args.defaults)
                )
            ),
            *node.args.defaults,
            *node.args.kw_defaults,
        ]
        for argument, default in zip(arguments, defaults, strict=True):
            has_sync_annotation = _annotation_has_sync_session(
                argument.annotation,
                aliases,
            )
            has_sync_dependency = _depends_on_sync_session(default, aliases)
            has_annotated_dependency = _depends_on_sync_session(
                argument.annotation,
                aliases,
            )
            if not (
                has_sync_annotation or has_sync_dependency or has_annotated_dependency
            ):
                continue
            violations.append(
                _Violation(
                    path=relative_path,
                    function=node.name,
                    line=argument.lineno,
                    call=f"sync Session parameter {argument.arg}",
                )
            )
    return violations


def _async_call_violations(path: Path) -> list[_Violation]:
    relative_path = path.relative_to(APP_ROOT.parent).as_posix()
    tree = ast.parse(path.read_text(), filename=str(path))
    aliases = _import_aliases(tree)
    violations: list[_Violation] = []

    class AsyncFunctionVisitor(ast.NodeVisitor):
        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            if (relative_path, node.name) not in _PRE_BIND_ALLOWLIST:
                body_visitor = AsyncBodyVisitor(node.name)
                for statement in node.body:
                    body_visitor.visit(statement)
            self.generic_visit(node)

    class AsyncBodyVisitor(ast.NodeVisitor):
        def __init__(self, function_name: str) -> None:
            self.function_name = function_name

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            del node

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            del node

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            del node

        def visit_Lambda(self, node: ast.Lambda) -> None:
            del node

        def visit_Call(self, node: ast.Call) -> None:
            call_name = _resolve_call_name(node, aliases)
            is_default_executor = (
                call_name.endswith(".run_in_executor")
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value is None
            )
            if (
                call_name in _BLOCKING_CALLS
                or call_name in _IMPLICIT_EXECUTOR_CALLS
                or is_default_executor
            ):
                violations.append(
                    _Violation(
                        path=relative_path,
                        function=self.function_name,
                        line=node.lineno,
                        call=call_name,
                    )
                )
            is_response_json = (
                isinstance(node.func, ast.Attribute) and node.func.attr == "json"
            )
            if call_name in _DIRECT_CODEC_CALLS or is_response_json:
                violations.append(
                    _Violation(
                        path=relative_path,
                        function=self.function_name,
                        line=node.lineno,
                        call=f"direct codec {call_name}",
                    )
                )
            method_name = node.func.attr if isinstance(node.func, ast.Attribute) else ""
            if method_name in _FILESYSTEM_METHODS:
                violations.append(
                    _Violation(
                        path=relative_path,
                        function=self.function_name,
                        line=node.lineno,
                        call=f"synchronous filesystem method {method_name}",
                    )
                )
            if method_name in _HTTP_METHODS and any(
                keyword.arg == "json" for keyword in node.keywords
            ):
                violations.append(
                    _Violation(
                        path=relative_path,
                        function=self.function_name,
                        line=node.lineno,
                        call=f"HTTP {method_name}(json=)",
                    )
                )
            self.generic_visit(node)

        def visit_Attribute(self, node: ast.Attribute) -> None:
            if node.attr == "text":
                receiver = _dotted_name(node.value).rsplit(".", 1)[-1]
                if receiver == "resp" or receiver.endswith("response"):
                    violations.append(
                        _Violation(
                            path=relative_path,
                            function=self.function_name,
                            line=node.lineno,
                            call=f"direct response text {_dotted_name(node)}",
                        )
                    )
            self.generic_visit(node)

    AsyncFunctionVisitor().visit(tree)
    return violations


def test_async_code_has_no_direct_blocking_calls() -> None:
    violations = [
        violation
        for path in sorted(APP_ROOT.rglob("*.py"))
        for violation in _async_call_violations(path)
    ]

    assert not violations, "\n" + "\n".join(
        violation.render() for violation in violations
    )


def test_web_handlers_do_not_receive_synchronous_database_sessions() -> None:
    violations = [
        violation
        for root in WEB_HANDLER_ROOTS
        for path in sorted(root.rglob("*.py"))
        for violation in _sync_session_violations(path)
    ]

    assert not violations, "\n" + "\n".join(
        violation.render() for violation in violations
    )
