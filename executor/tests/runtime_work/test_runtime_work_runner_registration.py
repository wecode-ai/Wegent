# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


def test_local_runner_registers_runtime_rpc_handler():
    from executor.modes.local.events import RuntimeEvents
    from executor.modes.local.runner import LocalRunner

    class Handler:
        def __getattr__(self, name):
            def handle(*args, **kwargs):
                return {"success": True}

            return handle

    runner = object.__new__(LocalRunner)
    registered = {}
    runner.websocket_client = type(
        "Client",
        (),
        {"on": lambda self, event, handler: registered.setdefault(event, handler)},
    )()
    runner.task_handler = Handler()
    runner.command_handler = Handler()
    runner.capability_sync_handler = Handler()
    runner.session_handler = Handler()
    runner.upgrade_handler = Handler()
    runner.extension_handler = Handler()
    runner.runtime_work_handler = type(
        "RuntimeHandler",
        (),
        {"handle_runtime_rpc": lambda self, data: data},
    )()
    runner._register_extension_handlers = lambda: None

    runner._register_handlers()

    assert RuntimeEvents.RPC in registered
