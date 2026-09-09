# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contracts owned by the Code Wiki submission skill."""

import json
import os
import shlex
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import yaml

SKILLS = Path(__file__).resolve().parents[4] / "init_data" / "skills"


def _skill(name: str) -> tuple[dict, str]:
    raw = (SKILLS / name / "SKILL.md").read_text()
    _, frontmatter, body = raw.split("---", 2)
    return yaml.safe_load(frontmatter), body


def _review_contract() -> str:
    return (SKILLS / "wiki_submit" / "REVIEW_CONTRACT.md").read_text()


def test_wiki_submit_owns_the_page_write_contract() -> None:
    metadata, body = _skill("wiki_submit")

    assert metadata["bindShells"] == ["ClaudeCode"]
    for subject in (
        "at most 4 folders",
        "complete content",
        "section that holds pages needs a substantive page",
        "architecture/backend/api",
        "both `architecture` and `architecture/backend`",
        "at least two independent child pages",
        "Titles name the subject",
        "[Backend](architecture/backend)",
        "--structure-order",
        "version was published",
        "node IDs distinct from subgraph IDs",
        "validate-mermaid",
        "pinned Mermaid parser plus a matching guard",
        "exits with code 2",
        "publish gate is authoritative",
        "`complete` again",
        "Before the first submit",
        "Before ending the run",
        "Do not report the generation as complete",
        "full-rebuild review checkpoint",
        "REVIEW_CONTRACT.md",
        "review-open",
        "review-status",
        "`nextAction`",
        "handoff-file",
        "writing-plan-file",
        "findings-file",
        "--repo-dir",
    ):
        assert subject in body


def test_review_contract_defines_every_handoff_and_result() -> None:
    contract = _review_contract()

    for subject in (
        "not_started -> ready -> passed | changes_requested",
        "Run the Reviewer synchronously",
        "Do not sleep",
        "# Plan handoff",
        "# QA handoff",
        "# Recheck handoff",
        "# Findings",
        "nextAction=fail_generation",
        "review-status --phase plan",
        "Candidate complete: yes",
        "QA finding:",
        "Work Packages",
        "Must explain",
        "missingPaths",
        "reviewPolicy",
        "plan_only",
        "plan_and_qa",
        "## Plan amendment",
        "plan_amendment",
        "effectivePlan",
        "Only the Coordinator",
    ):
        assert subject in contract


def test_review_command_prints_complete_persisted_state() -> None:
    script = (SKILLS / "wiki_submit" / "wiki_submit.js").read_text()

    assert "console.log(JSON.stringify(result))" in script
    assert "console.log(JSON.stringify(result.review || result))" not in script
    assert (
        "--writing-plan-file is required for a plan or amendment review handoff"
        in script
    )
    assert "--repo-dir is required for complete command" in script


def test_complete_counts_the_explicit_checkout_from_a_staging_directory(
    tmp_path,
) -> None:
    """``complete`` must not infer its checkout from a writer's temporary cwd."""

    node = shutil.which("node")
    git = shutil.which("git")
    assert node is not None, "wiki_submit requires Node.js at runtime"
    assert git is not None, "wiki_submit requires Git at runtime"
    payloads: list[dict] = []

    class SubmitHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - HTTP handler API
            content_length = self.headers.get("Content-Length")
            if content_length is not None:
                body = self.rfile.read(int(content_length))
            else:
                chunks: list[bytes] = []
                while True:
                    size = int(self.rfile.readline().split(b";", 1)[0], 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    chunks.append(self.rfile.read(size))
                    self.rfile.read(2)
                body = b"".join(chunks)
            payloads.append(json.loads(body))
            response = json.dumps({"status": "success", "published": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), SubmitHandler)
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        repository = SKILLS.parents[2]
        head_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repository, text=True
        ).strip()
        script = SKILLS / "wiki_submit" / "wiki_submit.js"
        endpoint = f"http://127.0.0.1:{server.server_port}/submit"
        command = [
            node,
            str(script),
            "complete",
            "--generation-id",
            "123",
            "--head-commit",
            head_commit,
            "--repo-dir",
            str(repository),
            "--endpoint",
            endpoint,
            "--token",
            "test-token",
        ]

        completed = subprocess.run(
            command, cwd=tmp_path, text=True, capture_output=True
        )

        assert completed.returncode == 0, completed.stderr
        assert payloads[0]["summary"]["head_commit"] == head_commit
        assert payloads[0]["summary"]["tracked_file_count"] > 0

        fake_bin = tmp_path / "fake-bin"
        fake_bin.mkdir()
        fake_git = fake_bin / "git"
        fake_git.write_text(
            "#!/bin/sh\n"
            'if [ "$3" = "ls-tree" ]; then\n'
            '  echo "simulated tree scan failure" >&2\n'
            "  exit 42\n"
            "fi\n"
            f'exec {shlex.quote(git)} "$@"\n'
        )
        fake_git.chmod(0o755)
        no_count = subprocess.run(
            command,
            cwd=tmp_path,
            text=True,
            capture_output=True,
            env={**os.environ, "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}"},
        )

        assert no_count.returncode == 0, no_count.stderr
        assert "could not count files from the documented commit" in no_count.stderr
        assert payloads[1]["summary"]["head_commit"] == head_commit
        assert "tracked_file_count" not in payloads[1]["summary"]

        missing_repository = subprocess.run(
            [
                argument
                for argument in command
                if argument not in {"--repo-dir", str(repository)}
            ],
            cwd=tmp_path,
            text=True,
            capture_output=True,
        )

        assert missing_repository.returncode == 1
        assert (
            "--repo-dir is required for complete command" in missing_repository.stderr
        )
        assert len(payloads) == 2
    finally:
        server.shutdown()
        server.server_close()
