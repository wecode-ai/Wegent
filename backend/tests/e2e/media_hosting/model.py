# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Simulated video and image models used by the real hybrid Backend."""

import base64
import hashlib
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import httpx
from PIL import Image


class ModelServer(ThreadingHTTPServer):
    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), ModelHandler)
        self.jobs: dict[str, dict] = {}
        self.failures: list[str] = []
        self.image_requests: list[tuple[str, str | None]] = []
        self.image_request_blocked = threading.Event()
        self.release_image_request = threading.Event()
        image = BytesIO()
        Image.new("RGB", (8, 8), "blue").save(image, format="PNG")
        self.image = image.getvalue()
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=10)


class ModelHandler(BaseHTTPRequestHandler):
    server: ModelServer

    def do_POST(self) -> None:
        if self.path == "/v1/images/generations":
            self.generate_image()
            return
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
                "options": {
                    key: payload.get(key) for key in ("resolution", "ratio", "duration")
                },
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

    def generate_image(self) -> None:
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = payload["prompt"]
        first_attempt = not any(
            previous_prompt == prompt
            for previous_prompt, _ in self.server.image_requests
        )
        self.server.image_requests.append((prompt, payload.get("size")))
        if prompt == "Cancel the blue square" and first_attempt:
            self.server.image_request_blocked.set()
            self.server.release_image_request.wait(timeout=20)
        if payload["model"] != "gpt-image-e2e":
            status, result = 400, {"error": {"message": "Unexpected image model"}}
        elif prompt == "Retry the blue square" and first_attempt:
            status, result = 503, {"error": {"message": "Image model test failure"}}
        else:
            status = 200
            result = {
                "data": [{"b64_json": base64.b64encode(self.server.image).decode()}]
            }
        body = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            if prompt != "Cancel the blue square" or not first_attempt:
                raise

    def log_message(self, format: str, *args: object) -> None:
        pass
