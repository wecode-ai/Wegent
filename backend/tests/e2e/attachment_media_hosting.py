# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Run real media-hosting E2E outside pytest's service-mocking conftest.

CI supplies dedicated MySQL, Redis, MinIO and the current Rust example binary.
Only the remote video model is simulated; its HTTP handler actually downloads
all reference media. Chat and MCP run through the public hybrid listener.
"""

import json
import os
import sys
import unittest

from media_hosting.fixture import REPORT, HostingFixture
from media_hosting.generation_cases import GenerationCases
from media_hosting.upload_cases import UploadCases


class AttachmentMediaHosting(UploadCases, GenerationCases, HostingFixture):
    pass


if __name__ == "__main__":
    REPORT.mkdir(parents=True, exist_ok=True)
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(AttachmentMediaHosting)
    )
    report = {
        "sha": os.environ["E2E_TEST_SHA"],
        "command": "uv run --no-sync python tests/e2e/attachment_media_hosting.py",
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "success": result.wasSuccessful()
        and result.testsRun == 10
        and not result.skipped,
    }
    (REPORT / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    sys.exit(0 if report["success"] else 1)
