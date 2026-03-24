# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for converting text slot answers to S3 attachments."""

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from wecode.models.evaluation_exam_session import EvalExamSession
from wecode.service.evaluation.storage_service import EvalStorageService

logger = logging.getLogger(__name__)


class TextConversionService:
    """Handles conversion of text slot content to S3 attachments."""

    @staticmethod
    def convert_text_slot_to_s3(
        db: Session,
        session: EvalExamSession,
        question_id: int,
        text_content: str,
        slot_key: str,
    ) -> Optional[dict]:
        """Convert text content to S3 attachment for a single slot.

        Args:
            db: Database session
            session: Exam session
            question_id: Question ID
            text_content: Text content to convert
            slot_key: Slot key name for file naming

        Returns:
            Attachment dict if conversion successful, None if no text or already converted
        """
        if not text_content or not text_content.strip():
            return None

        # Initialize storage service
        storage_service = EvalStorageService()

        # Check if storage is configured
        if not storage_service.client:
            logger.warning(
                "[TextConversion] S3 storage not configured, "
                "returning mock attachment structure"
            )
            return {
                "key": f"exam/{session.id}/question/{question_id}/{slot_key}.txt",
                "filename": f"question_{question_id}_{slot_key}.txt",
                "file_size": len(text_content.encode("utf-8")),
                "content_type": "text/plain",
            }

        try:
            # Generate storage key for exam text slot
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            filename = f"{slot_key}_{timestamp}.txt"
            key = storage_service.generate_upload_key(
                file_type="exam_attachment",
                user_id=session.user_id,
                topic_id=session.topic_id,
                question_id=question_id,
                slot=slot_key,
                filename=filename,
            )

            # Upload text content to S3
            data = text_content.encode("utf-8")
            uploaded_key = storage_service.upload_file(
                key=key,
                data=data,
                content_type="text/plain",
                filename=filename,
            )

            if not uploaded_key:
                logger.error(
                    f"[TextConversion] Failed to upload text to S3 "
                    f"for session {session.id}, question {question_id}, slot {slot_key}"
                )
                return None

            logger.info(
                f"[TextConversion] Successfully uploaded text to S3: {uploaded_key}"
            )

            return {
                "key": uploaded_key,
                "filename": filename,
                "file_size": len(data),
                "content_type": "text/plain",
            }

        except Exception as e:
            logger.error(
                f"[TextConversion] Error uploading text to S3 "
                f"for session {session.id}, question {question_id}, slot {slot_key}: {e}"
            )
            return None

    @staticmethod
    def convert_text_slots_for_answer(
        db: Session,
        session: EvalExamSession,
        question_id: int,
        answers: dict,
    ) -> dict:
        """Convert all text slot content in an answer to S3 files.

        Args:
            db: Database session
            session: Exam session
            question_id: Question ID
            answers: Dict of slot_key -> SlotAnswer

        Returns:
            Updated answers with converted text -> files
        """
        if not answers:
            return answers

        updated_answers = dict(answers)

        for slot_key, slot_answer in updated_answers.items():
            if not isinstance(slot_answer, dict):
                continue

            text = slot_answer.get("text", "")
            if text and text.strip():
                # Check if already has files (already converted)
                existing_files = slot_answer.get("files", [])
                if existing_files:
                    continue

                # Convert text to S3 file
                attachment = TextConversionService.convert_text_slot_to_s3(
                    db, session, question_id, text, slot_key
                )

                if attachment:
                    # Add file and clear text
                    updated_answers[slot_key] = {
                        **slot_answer,
                        "files": [attachment],
                        "text": "",
                    }
                    logger.info(
                        f"[TextConversion] Converted text slot {slot_key} for question {question_id}"
                    )

        return updated_answers
