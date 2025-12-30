# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Summary service for document summary generation.

Provides async document summary generation using LLM.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument, SummaryStatus
from app.services.attachment import attachment_service
from app.services.attachment.parser import document_parser
from app.services.simple_chat import simple_chat_service

logger = logging.getLogger(__name__)

# Summary prompt template for generating document summaries
SUMMARY_SYSTEM_PROMPT = """You are a professional document summarization assistant. Your task is to generate concise and accurate summaries of documents.

Requirements:
1. The summary should be between 300-500 characters
2. Capture the main points and key information from the document
3. Use clear, professional language
4. Do not add any information not present in the original document
5. Respond in the same language as the original document content"""

SUMMARY_USER_PROMPT_TEMPLATE = """Please summarize the following document content. The summary should be between 300-500 characters.

Document content:
{content}

Please provide a concise summary:"""

# Prompt for image documents
IMAGE_SUMMARY_PROMPT = """Please describe the content of this image in detail. The description should be between 300-500 characters, covering:
1. What the image shows
2. Key visual elements
3. Any text or data visible in the image (if applicable)

Please provide a concise description:"""

# Image file extensions
IMAGE_EXTENSIONS = frozenset([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"])


class SummaryService:
    """Service for generating document summaries using LLM."""

    @staticmethod
    def _build_summary_prompt(content: str) -> str:
        """
        Build the prompt for summary generation.

        Args:
            content: Document text content

        Returns:
            Formatted prompt string
        """
        # Truncate content if too long to avoid token limits
        max_content_length = 50000  # Limit content to ~50k chars for LLM
        if len(content) > max_content_length:
            content = content[:max_content_length] + "\n\n[Content truncated...]"

        return SUMMARY_USER_PROMPT_TEMPLATE.format(content=content)

    @staticmethod
    def _is_image_document(file_extension: str) -> bool:
        """Check if the document is an image file."""
        return file_extension.lower() in IMAGE_EXTENSIONS

    @staticmethod
    async def _call_llm(
        prompt: str,
        model_config: dict,
        system_prompt: str = SUMMARY_SYSTEM_PROMPT,
    ) -> str:
        """
        Call LLM to generate summary.

        Args:
            prompt: User prompt with document content
            model_config: LLM model configuration
            system_prompt: System prompt for the LLM

        Returns:
            Generated summary text

        Raises:
            ValueError: If LLM call fails
        """
        try:
            response = await simple_chat_service.chat_completion(
                message=prompt,
                model_config=model_config,
                system_prompt=system_prompt,
            )
            return response.strip()
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            raise ValueError(f"Failed to generate summary: {str(e)}") from e

    @staticmethod
    async def _call_llm_with_image(
        image_base64: str,
        mime_type: str,
        model_config: dict,
    ) -> str:
        """
        Call LLM with image content for vision-capable models.

        Args:
            image_base64: Base64 encoded image
            mime_type: Image MIME type
            model_config: LLM model configuration

        Returns:
            Generated image description

        Raises:
            ValueError: If LLM call fails
        """
        try:
            # Build vision message structure
            message = {
                "type": "vision",
                "text": IMAGE_SUMMARY_PROMPT,
                "image_base64": image_base64,
                "mime_type": mime_type,
            }

            response = await simple_chat_service.chat_completion(
                message=message,
                model_config=model_config,
                system_prompt=SUMMARY_SYSTEM_PROMPT,
            )
            return response.strip()
        except Exception as e:
            logger.error(f"Vision LLM call failed: {e}")
            # If vision fails, return a placeholder message
            return "Image document - summary generation requires vision-capable model"

    @staticmethod
    async def generate_summary_async(
        db: Session,
        document_id: int,
        model_config: dict,
    ) -> None:
        """
        Asynchronously generate document summary.

        This method:
        1. Updates document status to processing
        2. Retrieves document content via attachment
        3. Calls LLM to generate summary
        4. Saves summary to database
        5. Updates status to completed or failed

        Args:
            db: Database session
            document_id: Document ID to generate summary for
            model_config: LLM model configuration dict containing:
                - model: Provider type ('openai', 'claude', 'gemini')
                - api_key: API key
                - base_url: API base URL
                - model_id: Model identifier
                - default_headers: Optional custom headers
        """
        # Get document
        document = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )

        if not document:
            logger.error(f"Document {document_id} not found")
            return

        # Update status to processing
        document.summary_status = SummaryStatus.PROCESSING
        document.summary_error = None
        db.commit()

        try:
            # Get attachment content
            if not document.attachment_id:
                raise ValueError("Document has no associated attachment")

            attachment = attachment_service.get_attachment(
                db=db,
                attachment_id=document.attachment_id,
            )

            if not attachment:
                raise ValueError(f"Attachment {document.attachment_id} not found")

            # Check if it's an image document
            if SummaryService._is_image_document(document.file_extension):
                # For image documents, try to use vision model
                if attachment.image_base64:
                    summary = await SummaryService._call_llm_with_image(
                        image_base64=attachment.image_base64,
                        mime_type=attachment.mime_type,
                        model_config=model_config,
                    )
                else:
                    summary = "Image document - no image data available for summary generation"
            else:
                # For text documents, use extracted text
                content = attachment.extracted_text
                if not content or not content.strip():
                    raise ValueError("Document has no extractable text content")

                # Build prompt and generate summary
                prompt = SummaryService._build_summary_prompt(content)
                summary = await SummaryService._call_llm(
                    prompt=prompt,
                    model_config=model_config,
                )

            # Update document with summary
            document.summary = summary
            document.summary_status = SummaryStatus.COMPLETED
            document.summary_generated_at = datetime.now()
            document.summary_error = None
            db.commit()

            logger.info(
                f"Successfully generated summary for document {document_id}, "
                f"length: {len(summary)} chars"
            )

        except Exception as e:
            logger.error(f"Failed to generate summary for document {document_id}: {e}")
            # Update status to failed
            document.summary_status = SummaryStatus.FAILED
            document.summary_error = str(e)[:500]  # Truncate error message
            db.commit()


# Global service instance
summary_service = SummaryService()
