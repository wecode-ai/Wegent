# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The only simulated service: Seedance; input objects are really downloaded."""

import hashlib
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx


class ModelServer(ThreadingHTTPServer):
    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), ModelHandler)
        self.jobs: dict[str, dict] = {}
        self.failures: list[str] = []
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=10)


class ModelHandler(BaseHTTPRequestHandler):
    server: ModelServer

    def do_POST(self) -> None:
        try:
            assert self.path == "/contents/generations/tasks"
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            media = []
            for block in payload["content"]:
                if block["type"] not in {"video_url", "audio_url"}:
                    continue
                response = httpx.get(block[block["type"]]["url"], trust_env=False)
                response.raise_for_status()
                assert response.content, "Model received an empty media object"
                media.append(
                    {
                        "type": block["type"],
                        "sha256": hashlib.sha256(response.content).hexdigest(),
                    }
                )
            assert media, "The provider request lost its media references"
            job_id = uuid.uuid4().hex
            self.server.jobs[job_id] = {
                "media": media,
                "prompt": payload["content"][0]["text"],
            }
            body = json.dumps({"id": job_id}).encode()
            self.send_response(200)
        except Exception as exc:
            self.server.failures.append(str(exc))
            body = json.dumps({"error": str(exc)}).encode()
            self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass
