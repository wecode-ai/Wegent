#!/usr/bin/env python3
"""JSON helpers for the Executor Home persistence acceptance probe."""

import json
import sys
from pathlib import Path
from typing import Any


def load_payload(value: str) -> dict[str, Any]:
    payload = json.loads(value)
    if not isinstance(payload, dict):
        raise SystemExit("expected a JSON object")
    return payload


def read_config(path: str, field: str) -> None:
    payload = load_payload(Path(path).read_text(encoding="utf-8"))
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"missing non-empty {field} in {path}")
    print(value.strip(), end="")


def assert_capability(value: str, device_id: str) -> None:
    payload = load_payload(value)
    worktrees = payload.get("runtimeWorktrees")
    if payload.get("success") is not True:
        raise SystemExit("capability response was not successful")
    if payload.get("deviceId") != device_id:
        raise SystemExit("capability response belongs to another logical device")
    if not isinstance(worktrees, dict):
        raise SystemExit("capability response omitted runtimeWorktrees")
    if worktrees.get("managed") is not True or worktrees.get("preflight") is not True:
        raise SystemExit("managed Worktree capability is unavailable")
    if worktrees.get("persistentStorageVerified") is not True:
        raise SystemExit(
            "persistent storage is not verified by the Executor capability"
        )


def prepare_params(source_path: str, worktree_id: str) -> None:
    print(json.dumps({"sourcePath": source_path, "worktreeId": worktree_id}))


def prepared_path(value: str) -> None:
    payload = load_payload(value)
    path = payload.get("path")
    if payload.get("success") is not True or not isinstance(path, str) or not path:
        raise SystemExit("prepare response omitted a successful Worktree path")
    print(path, end="")


def assert_listed(value: str, device_id: str, worktree_id: str, path: str) -> None:
    payload = load_payload(value)
    items = payload.get("items")
    if payload.get("success") is not True or payload.get("deviceId") != device_id:
        raise SystemExit("Worktree list response has the wrong device identity")
    if not isinstance(items, list):
        raise SystemExit("Worktree list response omitted items")
    matches = [
        item
        for item in items
        if item.get("worktreeId") == worktree_id and item.get("path") == path
    ]
    if len(matches) != 1:
        raise SystemExit("persisted Worktree was not listed exactly once")
    if matches[0].get("deviceId") != device_id:
        raise SystemExit("persisted Worktree belongs to another logical device")


def assert_absent(value: str, worktree_id: str, path: str) -> None:
    payload = load_payload(value)
    items = payload.get("items")
    if payload.get("success") is not True or not isinstance(items, list):
        raise SystemExit("Worktree list response is invalid after deletion")
    if any(
        item.get("worktreeId") == worktree_id or item.get("path") == path
        for item in items
    ):
        raise SystemExit("deleted Worktree remains in Executor state")


def delete_params(path: str) -> None:
    print(json.dumps({"path": path, "preserveSnapshot": False}))


def main() -> int:
    command, *args = sys.argv[1:]
    commands = {
        "read-config": read_config,
        "assert-capability": assert_capability,
        "prepare-params": prepare_params,
        "prepared-path": prepared_path,
        "assert-listed": assert_listed,
        "assert-absent": assert_absent,
        "delete-params": delete_params,
    }
    handler = commands.get(command)
    if handler is None:
        raise SystemExit(f"unsupported command: {command}")
    handler(*args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
