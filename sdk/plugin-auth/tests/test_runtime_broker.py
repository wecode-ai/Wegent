# SPDX-License-Identifier: Apache-2.0
"""Exercise the SDK's real HTTP client with a bounded, delayed loopback broker."""

import contextlib
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wegent_plugin_auth import AuthError, run_account_command, runtime


class BrokerRuntimeTests(unittest.TestCase):
    @contextlib.contextmanager
    def broker(self, result, *, status=200, delay=0):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                payload = self.rfile.read(int(self.headers["Content-Length"]))
                requests.append(
                    (self.path, self.headers["Authorization"], json.loads(payload))
                )
                time.sleep(delay)
                body = json.dumps(result).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    # A timeout regression closes the client before the reply.
                    pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(
            target=lambda: server.serve_forever(poll_interval=0.01), daemon=True
        )
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                root = home / "capabilities/store/plugins/mail"
                root.mkdir(parents=True)
                (home / "capabilities/manifest-v2.json").write_text(
                    json.dumps(
                        {
                            "plugins": {
                                "mail": {
                                    "installed_plugin_id": 42,
                                    "managed": True,
                                    "enabled": True,
                                    "store_path": "store/plugins/mail",
                                }
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                with patch.dict(
                    os.environ,
                    {
                        "WEGENT_EXECUTOR_HOME": str(home),
                        "WEGENT_PLUGIN_AUTH_BROKER": f"http://127.0.0.1:{server.server_port}/v1/run",
                        "WEGENT_PLUGIN_AUTH_BROKER_TOKEN": "a" * 64,
                    },
                    clear=True,
                ):
                    yield root, requests
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())

    def test_explicit_local_account_waits_for_slow_python_preparation(self):
        # Complete after the old 1080s SDK deadline but within the current
        # 960s preparation plus 180s action budget, using the real HTTP client.
        scale = 0.002
        opener = runtime.urllib.request.build_opener(
            runtime.urllib.request.ProxyHandler({}), runtime._NoRedirect()
        )
        timeouts = []

        class ScaledOpener:
            def open(self, request, *, timeout):
                timeouts.append(timeout)
                return opener.open(request, timeout=timeout * scale)

        with (
            self.broker(
                {"stdout": "prepared mailbox result"}, delay=1120 * scale
            ) as fixture,
            patch.object(
                runtime.urllib.request, "build_opener", return_value=ScaledOpener()
            ),
        ):
            root, requests = fixture
            result = run_account_command(root, "mail", ["read"], account_id="alice")

        self.assertEqual(result, "prepared mailbox result")
        self.assertGreater(timeouts[0], 13 * 60 + 180)
        self.assertGreater(timeouts[0], 16 * 60 + 180)
        self.assertEqual(requests[0][0], "/v1/run")
        self.assertEqual(requests[0][1], "Bearer " + "a" * 64)
        self.assertEqual(requests[0][2]["account_id"], "alice")
        self.assertEqual(requests[0][2]["installed_plugin_id"], 42)

    def test_broker_deadline_covers_current_native_stage_budgets(self):
        repository = Path(__file__).resolve().parents[3]
        preparation = (repository / "executor/src/python_runtime.rs").read_text(
            encoding="utf-8"
        )
        action = (
            repository / "executor/src/plugin_account_auth/execution.rs"
        ).read_text(encoding="utf-8")
        native_request = (repository / "executor/src/local/app_ipc.rs").read_text(
            encoding="utf-8"
        )
        preparation_match = re.search(
            r"PYTHON_RUNTIME_ENSURE_TIMEOUT_SECONDS: u64 = (\d+) \* 60;", preparation
        )
        action_match = re.search(
            r"timeout\(Duration::from_secs\((\d+)\), action\)", action
        )
        request_match = re.search(
            r"crate::python_runtime::PYTHON_RUNTIME_ENSURE_TIMEOUT_SECONDS\s*\+ (\d+) \* 60;",
            native_request,
        )
        self.assertIsNotNone(preparation_match)
        self.assertIsNotNone(action_match)
        self.assertIsNotNone(request_match)
        preparation_seconds = int(preparation_match.group(1)) * 60
        action_seconds = int(action_match.group(1))
        self.assertEqual(preparation_seconds, 16 * 60)
        self.assertEqual(action_seconds, 180)
        self.assertGreater(
            runtime.BROKER_REQUEST_TIMEOUT_SECONDS, preparation_seconds + action_seconds
        )
        self.assertEqual(
            runtime.BROKER_REQUEST_TIMEOUT_SECONDS,
            preparation_seconds + int(request_match.group(1)) * 60 + 5,
        )

    def test_failed_python_preparation_returns_the_public_error(self):
        with self.broker(
            {"error": "python_runtime_unavailable"}, status=400
        ) as fixture:
            with self.assertRaisesRegex(AuthError, "^python_runtime_unavailable$"):
                run_account_command(fixture[0], "mail", ["read"], account_id="alice")
