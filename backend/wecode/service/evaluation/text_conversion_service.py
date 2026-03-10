# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for converting long text answers to S3 attachments."""

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from wecode.models.evaluation_exam_session import EvalExamSession
from wecode.service.evaluation.storage_service import EvalStorageService

logger = logging.getLogger(__name__)


class TextConversionService:
    """Handles conversion of supplementary notes text to S3 attachments."""

    @staticmethod
    def convert_question_notes_to_s3(
        db: Session,
        session: EvalExamSession,
        question_id: int,
        notes_text: str,
    ) -> Optional[dict]:
        """Convert supplementary notes text to S3 attachment for a single question.

        Args:
            db: Database session
            session: Exam session
            question_id: Question ID
            notes_text: Text content to convert

        Returns:
            Attachment dict if conversion successful, None if no text or already converted
        """
        if not notes_text or not notes_text.strip():
            return None

        # Initialize storage service
        storage_service = EvalStorageService()

        # Check if storage is configured
        if not storage_service.client:
            logger.warning(
                "[TextConversion] S3 storage not configured, "
                "returning mock attachment structure"
            )
            # Return mock structure when S3 is not configured
            # Use field names consistent with EvalAttachment interface (filename, file_size, content_type)
            return {
                "key": f"exam/{session.id}/question/{question_id}/notes.txt",
                "filename": f"question_{question_id}_notes.txt",
                "file_size": len(notes_text.encode("utf-8")),
                "content_type": "text/plain",
            }

        try:
            # Generate storage key for exam notes
            # Use the same slot name and filename format as the original frontend implementation
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            filename = f"作答说明_{timestamp}.txt"
            key = storage_service.generate_upload_key(
                file_type="exam_attachment",
                user_id=session.user_id,
                topic_id=session.topic_id,
                question_id=question_id,
                slot="supplementaryNotes",
                filename=filename,
            )

            # Upload text content to S3
            data = notes_text.encode("utf-8")
            uploaded_key = storage_service.upload_file(
                key=key,
                data=data,
                content_type="text/plain",
                filename=filename,
            )

            if not uploaded_key:
                logger.error(
                    f"[TextConversion] Failed to upload notes to S3 "
                    f"for session {session.id}, question {question_id}"
                )
                return None

            logger.info(
                f"[TextConversion] Successfully uploaded notes to S3: {uploaded_key}"
            )

            # Return attachment dict with the same structure as the original implementation
            # Use field names consistent with EvalAttachment interface (filename, file_size, content_type)
            return {
                "key": uploaded_key,
                "filename": filename,
                "file_size": len(data),
                "content_type": "text/plain",
            }

        except Exception as e:
            logger.error(
                f"[TextConversion] Error uploading notes to S3 "
                f"for session {session.id}, question {question_id}: {e}"
            )
            return None

    @staticmethod
    def convert_all_questions_notes(
        db: Session,
        session: EvalExamSession,
        answers_data: dict,
    ) -> dict:
        """Convert notes for all questions in the exam session.

        Args:
            db: Database session
            session: Exam session
            answers_data: Dict mapping question_id to answer data containing supplementaryNotes

        Returns:
            Updated answers_data with converted attachments
        """
        logger.info(
            f"[TextConversion] convert_all_questions_notes called with {len(answers_data)} answers"
        )
        updated_data = answers_data.copy()

        for question_id, answer in updated_data.items():
            notes = answer.get("supplementaryNotes", "")
            if notes and notes.strip():
                attachment = TextConversionService.convert_question_notes_to_s3(
                    db, session, int(question_id), notes
                )
                if attachment:
                    # Replace old files with new one (only keep latest)
                    answer["supplementaryNotesFiles"] = [attachment]
                    answer["supplementaryNotes"] = ""
                    logger.info(
                        f"[TextConversion] Question {question_id}: converted notes to S3 attachment"
                    )

        logger.info(f"[TextConversion] Conversion complete")
        return updated_data
