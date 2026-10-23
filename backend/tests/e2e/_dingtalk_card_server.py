"""Local DingTalk OpenAPI recorder for the notification-card E2E."""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

ACCESS_TOKEN = "dingtalk-card-e2e-token"


class RecordingDingTalkServer:
    """Record the DingTalk OpenAPI calls made by the production sender."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: list[dict[str, Any]] = []
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        if self._httpd is None:
            raise RuntimeError("DingTalk recording server is not running")
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def requests(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._requests)

    def start(self) -> None:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length)
                body = json.loads(raw) if raw else {}
                owner._record(self.path, body)

                if self.path == "/v1.0/oauth2/accessToken":
                    response: dict[str, Any] = {
                        "accessToken": ACCESS_TOKEN,
                        "expireIn": 7200,
                    }
                elif self.path == "/v1.0/card/instances/createAndDeliver":
                    response = {"processQueryKey": f"card-{uuid.uuid4().hex}"}
                elif self.path == "/v1.0/robot/oToMessages/batchSend":
                    response = {"processQueryKey": f"message-{uuid.uuid4().hex}"}
                else:
                    payload = json.dumps(
                        {"code": "NotFound", "message": self.path}
                    ).encode()
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return

                payload = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name="dingtalk-card-e2e",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._httpd = None
        self._thread = None

    def cards(self) -> list[dict[str, Any]]:
        return [
            request["body"]
            for request in self.requests
            if request["path"] == "/v1.0/card/instances/createAndDeliver"
        ]

    async def wait_for_card(
        self,
        *,
        after: int,
        item_key: str,
    ) -> dict[str, Any]:
        """Wait for the background delivery to emit one specific card."""

        loop = asyncio.get_running_loop()
        deadline = loop.time() + 20
        while loop.time() < deadline:
            for request in self.cards()[after:]:
                params = request["cardData"]["cardParamMap"]
                if params.get("itemKey") == item_key:
                    return request
            await asyncio.sleep(0.05)
        raise AssertionError(
            "DingTalk card was not delivered for "
            f"item_key={item_key}; requests={self.requests[-8:]}"
        )

    def _record(self, path: str, body: dict[str, Any]) -> None:
        with self._lock:
            self._requests.append({"path": path, "body": body})
