# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise command deadlines through the SDK, Executor Manager, and envd."""

import asyncio
import os
from time import monotonic
from uuid import uuid4

from e2b.exceptions import TimeoutException
from e2b_code_interpreter import AsyncSandbox

from chat_shell.tools.sandbox import patch_e2b_sdk


async def verify_long_command(sandbox: AsyncSandbox) -> None:
    started_at = monotonic()
    result = await asyncio.wait_for(
        sandbox.commands.run(
            "sleep 61; printf 'long command completed\\n'",
            timeout=90,
            request_timeout=5,
        ),
        timeout=100,
    )
    elapsed = monotonic() - started_at
    assert result.exit_code == 0, result
    assert result.stdout == "long command completed\n", result
    assert elapsed > 60, elapsed
    print(f"SDK foreground command succeeded after {elapsed:.1f}s", flush=True)


async def verify_deadline_and_cleanup(sandbox: AsyncSandbox) -> None:
    pid_path = "/tmp/wegent-e2e-deadline-child.pid"
    deadline_seconds = 3
    try:
        await asyncio.wait_for(
            sandbox.commands.run(
                f"sleep 30 & child=$!; printf '%s\\n' \"$child\" > {pid_path}; "
                'wait "$child"',
                timeout=deadline_seconds,
                request_timeout=5,
            ),
            timeout=12,
        )
    except TimeoutException as exc:
        detail = f"Sandbox command exceeded its {deadline_seconds * 1000} ms deadline"
        assert detail in str(exc), exc
        print(f"SDK received the envd deadline as {type(exc).__name__}", flush=True)
    else:
        raise AssertionError("SDK command exceeded its deadline without an error")

    child_pid = int(await sandbox.files.read(pid_path, request_timeout=5))
    assert child_pid > 1, child_pid

    # A zombie has exited and cannot execute, even if PID 1 has yet to reap it.
    result = await asyncio.wait_for(
        sandbox.commands.run(
            f"""
            for ((attempt = 0; attempt < 40; attempt++)); do
                if ! read -r pid name state rest 2>/dev/null < /proc/{child_pid}/stat ||
                   [[ "$state" == Z ]]; then
                    printf 'child exited\\n'
                    exit 0
                fi
                sleep 0.05
            done
            printf 'deadline child %s is still running\\n' {child_pid} >&2
            exit 1
            """,
            timeout=5,
            request_timeout=5,
        ),
        timeout=8,
    )
    assert result.exit_code == 0, result
    assert result.stdout == "child exited\n", result
    print(
        "Deadline child exited and the same sandbox handled a follow-up command",
        flush=True,
    )


async def main() -> None:
    assert patch_e2b_sdk(), "Wegent SDK routing could not be initialized"
    # The patched URL preserves HTTP. Disable SDK debug mode so context exit deletes the sandbox.
    os.environ.pop("E2B_DEBUG", None)
    async with await AsyncSandbox.create(
        template="ClaudeCode",
        timeout=300,
        request_timeout=120,
        metadata={
            "task_id": str((1 << 48) + (uuid4().int >> 80)),
            "task_type": "sandbox",
            "user_id": "1",
            "user_name": "sandbox-deadline-e2e",
        },
    ) as sandbox:
        await verify_long_command(sandbox)
        await verify_deadline_and_cleanup(sandbox)


if __name__ == "__main__":
    asyncio.run(main())
