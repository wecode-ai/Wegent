# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise hosting decisions and rollback through the production HTTP API."""

import hashlib
import uuid

import httpx

from app.db.session import SessionLocal
from app.models import SubtaskContext


class UploadCases:
    def test_hosted_video_and_audio_are_committed_ready(self) -> None:
        for media_type, extension, purpose in (
            ("video", "mp4", "default"),
            ("video", "mp4", "video_reference"),
            ("audio", "wav", "default"),
        ):
            with self.subTest(media_type=media_type, purpose=purpose):
                content = self.media[media_type]
                response = self.upload(
                    f"ready-{uuid.uuid4().hex}.{extension}", content, purpose
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["status"], "ready")
                row = self.attachment(response.json()["id"])
                self.assertEqual(row.status, "ready")
                self.assertFalse(row.binary_data)
                self.assertEqual(row.text_length, 0)
                self.assertFalse(row.extracted_text)
                self.assertNotIn(
                    "is_truncated", row.type_data, "Document parsing must be bypassed"
                )
                self.assertEqual(row.type_data["storage_backend"], "media_minio")
                hosted = row.type_data["hosted_media"]
                self.assertEqual(hosted["owner_id"], self.user_id)
                self.assertEqual(hosted["sha256"], hashlib.sha256(content).hexdigest())
                self.assertEqual(hosted["media_id"], row.storage_key)
                self.assertTrue(hosted["probe"]["streams"])
                stat = self.store.stat_object(self.bucket, row.storage_key)
                self.assertEqual(stat.size, len(content))
                self.assertEqual(int(stat.metadata["x-amz-meta-user_id"]), self.user_id)
                self.evidence.append(
                    {
                        "case": "committed_ready",
                        "attachment_id": row.id,
                        "user_id": self.user_id,
                        "media_type": media_type,
                        "purpose": purpose,
                        "sha256": hosted["sha256"],
                        "parser_bypassed": True,
                    }
                )

    def assert_rollback(
        self,
        filename: str,
        content: bytes,
        expected_status: int,
        purpose: str = "default",
    ) -> httpx.Response:
        objects_before = self.objects()
        response = self.upload(filename, content, purpose)
        self.assertEqual(response.status_code, expected_status, response.text)
        with SessionLocal() as db:
            self.assertEqual(
                db.query(SubtaskContext)
                .filter_by(user_id=self.user_id, name=filename)
                .count(),
                0,
            )
        self.assertEqual(
            self.objects(), objects_before, "Failure left an orphaned object"
        )
        self.evidence.append(
            {
                "case": self._testMethodName,
                "status": expected_status,
                "attachment_rows": 0,
                "objects_added": 0,
            }
        )
        return response

    def test_mime_and_purpose_choose_the_ordinary_store(self) -> None:
        # The ordinary bucket genuinely does not exist. A wrong hosting decision
        # would instead succeed, making both selection regressions observable.
        self.assert_rollback(
            "ordinary-audio-" + uuid.uuid4().hex + ".wav",
            self.media["audio"],
            500,
            "video_reference",
        )
        self.assert_rollback(
            "ordinary-text-" + uuid.uuid4().hex + ".txt", b"ordinary document", 500
        )

    def test_invalid_media_returns_400_without_rows_or_objects(self) -> None:
        for extension in ("mp4", "wav"):
            with self.subTest(extension=extension):
                response = self.assert_rollback(
                    f"invalid-{uuid.uuid4().hex}.{extension}", b"not media", 400
                )
                self.assertEqual(
                    response.json(), {"detail": "The file is not valid video or audio"}
                )

    def test_real_provider_rejection_returns_500_and_rolls_back(self) -> None:
        # MinIO's real IAM policy denies this otherwise valid video by its hash.
        response = self.assert_rollback(
            "unavailable-" + uuid.uuid4().hex + ".mp4", self.media["denied"], 500
        )
        self.assertEqual(response.json(), {"detail": "Failed to upload attachment"})
