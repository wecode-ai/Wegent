# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import re
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BACKEND_DIR.parent
APP_DIR = BACKEND_DIR / "app"
ALLOWED_DIRS = {
    APP_DIR / "models",
    APP_DIR / "stores" / "tasks",
}
FORBIDDEN_OWNER_PROTOCOL_PATHS = [
    REPO_DIR / "shared" / "models",
    REPO_DIR / "executor" / "agents",
    REPO_DIR / "executor" / "services",
    REPO_DIR / "executor" / "tasks",
    REPO_DIR / "executor_manager" / "clients",
    REPO_DIR / "executor_manager" / "executors",
    REPO_DIR / "executor_manager" / "routers",
    REPO_DIR / "executor_manager" / "services",
    REPO_DIR / "chat_shell" / "chat_shell",
    APP_DIR / "services" / "execution",
    APP_DIR / "api" / "endpoints" / "internal" / "callback.py",
    APP_DIR / "api" / "ws" / "device_namespace.py",
]
FORBIDDEN_OWNER_PROTOCOL_PATTERNS = [
    re.compile(r"task_owner_user_id"),
    re.compile(r"\.with_user_id\("),
]
FORBIDDEN_OWNER_PROTOCOL_FILE_PATTERNS = {
    REPO_DIR
    / "executor_manager"
    / "clients"
    / "callback_client.py": [
        re.compile(r"user_id:\s*Optional\[int\]"),
        re.compile(r"event_data\[[\"']user_id[\"']\]"),
    ],
    REPO_DIR
    / "executor_manager"
    / "services"
    / "task_heartbeat_manager.py": [
        re.compile(r"user_id_str"),
        re.compile(r"send_error\([^)]*user_id"),
    ],
    REPO_DIR
    / "chat_shell"
    / "chat_shell"
    / "main.py": [
        re.compile(r"metadata\.get\([\"']user_id[\"']\)"),
    ],
    REPO_DIR
    / "executor"
    / "app.py": [
        re.compile(r"metadata\.get\([\"']user_id[\"']\)"),
        re.compile(r"request=.*openai_request"),
    ],
    APP_DIR
    / "api"
    / "ws"
    / "device_namespace.py": [
        re.compile(r"_get_task_owner_id"),
        re.compile(r"event_user_id"),
        re.compile(r"task_owner_id"),
    ],
}

DIRECT_CRUD_PATTERN = re.compile(
    r"(?:db|session|query_db|self\._db)\.(?:query|get)\(\s*(?:TaskResource|Subtask)\b"
)
SQLALCHEMY_CORE_CRUD_PATTERN = re.compile(
    r"\b(?:select|update|delete)\(\s*(?:TaskResource|Subtask)\b"
)
CONSTRUCTOR_PATTERN = re.compile(r"\b(?:TaskResource|Subtask)\(")
KNOWN_LEGACY_SQLALCHEMY_CORE_CRUD = {
    "app/services/adapters/executor_job.py",
    "app/services/chat/preprocessing/contexts.py",
    "app/services/executor_cleanup_cursor_service.py",
}


def _is_allowed(path: Path) -> bool:
    return any(path.is_relative_to(allowed_dir) for allowed_dir in ALLOWED_DIRS)


def _find_violations(pattern: re.Pattern[str]) -> list[str]:
    violations = []
    for path in APP_DIR.rglob("*.py"):
        if _is_allowed(path):
            continue
        for line_number, line in enumerate(path.read_text().splitlines(), start=1):
            if pattern.search(line):
                relative_path = path.relative_to(BACKEND_DIR)
                violations.append(f"{relative_path}:{line_number}: {line.strip()}")
    return violations


def _find_sqlalchemy_core_crud_violations() -> list[str]:
    violations = []
    for path in APP_DIR.rglob("*.py"):
        if _is_allowed(path):
            continue
        relative_path = path.relative_to(BACKEND_DIR).as_posix()
        if relative_path in KNOWN_LEGACY_SQLALCHEMY_CORE_CRUD:
            continue
        for line_number, line in enumerate(path.read_text().splitlines(), start=1):
            if SQLALCHEMY_CORE_CRUD_PATTERN.search(line):
                violations.append(f"{relative_path}:{line_number}: {line.strip()}")
    return violations


def _find_task_owner_protocol_leaks() -> list[str]:
    violations = []
    for root in FORBIDDEN_OWNER_PROTOCOL_PATHS:
        paths = [root] if root.is_file() else root.rglob("*.py")
        for path in paths:
            if not path.exists() or not path.is_file():
                continue
            for line_number, line in enumerate(path.read_text().splitlines(), start=1):
                for pattern in FORBIDDEN_OWNER_PROTOCOL_PATTERNS:
                    if pattern.search(line):
                        relative_path = path.relative_to(REPO_DIR)
                        violations.append(
                            f"{relative_path}:{line_number}: {line.strip()}"
                        )
                for pattern in FORBIDDEN_OWNER_PROTOCOL_FILE_PATTERNS.get(path, []):
                    if pattern.search(line):
                        relative_path = path.relative_to(REPO_DIR)
                        violations.append(
                            f"{relative_path}:{line_number}: {line.strip()}"
                        )
    return violations


def test_task_subtask_direct_crud_stays_inside_stores():
    violations = _find_violations(DIRECT_CRUD_PATTERN)
    violations.extend(_find_sqlalchemy_core_crud_violations())

    assert violations == []


def test_task_subtask_orm_construction_stays_inside_stores():
    violations = _find_violations(CONSTRUCTOR_PATTERN)

    assert violations == []


def test_task_owner_uid_stays_out_of_open_source_protocols():
    violations = _find_task_owner_protocol_leaks()

    assert (
        violations == []
    ), "task owner uid must not be part of open-source cross-service protocols"
