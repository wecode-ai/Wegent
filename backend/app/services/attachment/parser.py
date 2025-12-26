# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document parser service for extracting text from various file formats.

Supports: PDF, Word (.doc, .docx), PowerPoint (.ppt, .pptx),
Excel (.xls, .xlsx, .csv), TXT, Markdown files, and Images (.jpg, .jpeg, .png, .gif, .bmp, .webp).
"""

import base64
import csv
import io
import logging
from dataclasses import dataclass
from typing import Optional, Tuple

import chardet

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class TruncationInfo:
    """Information about content truncation."""

    is_truncated: bool = False
    original_length: Optional[int] = None
    truncated_length: Optional[int] = None


@dataclass
class ParseResult:
    """Result of document parsing."""

    text: str
    text_length: int
    image_base64: Optional[str] = None
    truncation_info: Optional[TruncationInfo] = None


class DocumentParseError(Exception):
    """Exception raised when document parsing fails."""

    # Error codes for i18n mapping
    UNSUPPORTED_TYPE = "unsupported_type"
    FILE_TOO_LARGE = "file_too_large"
    PARSE_FAILED = "parse_failed"
    ENCRYPTED_PDF = "encrypted_pdf"
    LEGACY_DOC = "legacy_doc"
    LEGACY_PPT = "legacy_ppt"
    LEGACY_XLS = "legacy_xls"

    def __init__(self, message: str, error_code: Optional[str] = None):
        super().__init__(message)
        self.error_code = error_code or self.PARSE_FAILED


class DocumentParser:
    """
    Document parser for extracting text content from various file formats.

    Supported formats:
    - PDF (.pdf)
    - Word (.doc, .docx)
    - PowerPoint (.ppt, .pptx)
    - Excel (.xls, .xlsx, .csv)
    - Plain text (.txt)
    - Markdown (.md)
    - Images (.jpg, .jpeg, .png, .gif, .bmp, .webp)
    """

    # Supported file extensions and their MIME types
    SUPPORTED_EXTENSIONS = {
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".csv": "text/csv",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".webp": "image/webp",
    }

    @classmethod
    def get_max_file_size(cls) -> int:
        """Get maximum file size from configuration (in bytes)."""
        return settings.MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024

    @classmethod
    def get_max_text_length(cls) -> int:
        """Get maximum extracted text length from configuration."""
        return settings.MAX_EXTRACTED_TEXT_LENGTH

    @classmethod
    def is_supported_extension(cls, extension: str) -> bool:
        """Check if the file extension is supported."""
        return extension.lower() in cls.SUPPORTED_EXTENSIONS

    @classmethod
    def get_mime_type(cls, extension: str) -> str:
        """Get MIME type for a file extension."""
        return cls.SUPPORTED_EXTENSIONS.get(
            extension.lower(), "application/octet-stream"
        )

    @classmethod
    def validate_file_size(cls, size: int) -> bool:
        """Check if file size is within limits."""
        return size <= cls.get_max_file_size()

    @classmethod
    def validate_text_length(cls, text: str) -> bool:
        """Check if extracted text length is within limits."""
        return len(text) <= cls.get_max_text_length()

    def parse(self, binary_data: bytes, extension: str) -> ParseResult:
        """
        Parse document and extract text content.

        Args:
            binary_data: File binary data
            extension: File extension (e.g., '.pdf', '.docx')

        Returns:
            ParseResult with extracted text, length, optional image_base64,
            and truncation_info if content was truncated

        Raises:
            DocumentParseError: If parsing fails
        """
        extension = extension.lower()

        if not self.is_supported_extension(extension):
            raise DocumentParseError(
                f"Unsupported file type: {extension}",
                DocumentParseError.UNSUPPORTED_TYPE,
            )

        try:
            image_base64 = None
            truncation_info = None

            if extension == ".pdf":
                text = self._parse_pdf(binary_data)
            elif extension in [".doc", ".docx"]:
                text = self._parse_word(binary_data, extension)
            elif extension in [".ppt", ".pptx"]:
                text = self._parse_powerpoint(binary_data, extension)
            elif extension in [".xls", ".xlsx"]:
                text = self._parse_excel(binary_data, extension)
            elif extension == ".csv":
                text = self._parse_csv(binary_data)
            elif extension in [".txt", ".md"]:
                text = self._parse_text(binary_data)
            elif extension in [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]:
                text, image_base64 = self._parse_image(binary_data, extension)
            else:
                raise DocumentParseError(
                    f"Unsupported file type: {extension}",
                    DocumentParseError.UNSUPPORTED_TYPE,
                )

            # Auto-truncate if text exceeds maximum length
            max_length = self.get_max_text_length()
            if len(text) > max_length:
                original_length = len(text)
                text = text[:max_length]
                truncation_info = TruncationInfo(
                    is_truncated=True,
                    original_length=original_length,
                    truncated_length=max_length,
                )
                logger.info(
                    f"Text truncated from {original_length} to {max_length} characters"
                )

            return ParseResult(
                text=text,
                text_length=len(text),
                image_base64=image_base64,
                truncation_info=truncation_info,
            )

        except DocumentParseError:
            raise
        except Exception as e:
            logger.error(f"Error parsing document: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse document: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_pdf(self, binary_data: bytes) -> str:
        """Parse PDF file and extract text."""
        try:
            from PyPDF2 import PdfReader

            pdf_file = io.BytesIO(binary_data)
            reader = PdfReader(pdf_file)

            # Check if PDF is encrypted
            if reader.is_encrypted:
                raise DocumentParseError(
                    "Cannot parse encrypted PDF file",
                    DocumentParseError.ENCRYPTED_PDF,
                )

            text_parts = []
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)

            return "\n\n".join(text_parts)

        except DocumentParseError:
            raise
        except Exception as e:
            logger.error(f"Error parsing PDF: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse PDF: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_word(self, binary_data: bytes, extension: str) -> str:
        """Parse Word document and extract text."""
        try:
            if extension == ".doc":
                # For .doc files, we need to handle them differently
                # python-docx only supports .docx format
                raise DocumentParseError(
                    "Legacy .doc format is not fully supported. Please convert to .docx",
                    DocumentParseError.LEGACY_DOC,
                )

            from docx import Document

            doc_file = io.BytesIO(binary_data)
            doc = Document(doc_file)

            text_parts = []
            for paragraph in doc.paragraphs:
                if paragraph.text.strip():
                    text_parts.append(paragraph.text)

            # Also extract text from tables
            for table in doc.tables:
                for row in table.rows:
                    row_text = []
                    for cell in row.cells:
                        if cell.text.strip():
                            row_text.append(cell.text.strip())
                    if row_text:
                        text_parts.append(" | ".join(row_text))

            return "\n\n".join(text_parts)

        except DocumentParseError:
            raise
        except Exception as e:
            logger.error(f"Error parsing Word document: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse Word document: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_powerpoint(self, binary_data: bytes, extension: str) -> str:
        """Parse PowerPoint file and extract text (text only, no images)."""
        try:
            if extension == ".ppt":
                raise DocumentParseError(
                    "Legacy .ppt format is not fully supported. Please convert to .pptx",
                    DocumentParseError.LEGACY_PPT,
                )

            from pptx import Presentation

            ppt_file = io.BytesIO(binary_data)
            prs = Presentation(ppt_file)

            text_parts = []
            for slide_num, slide in enumerate(prs.slides, 1):
                slide_text = [f"--- Slide {slide_num} ---"]

                for shape in slide.shapes:
                    if hasattr(shape, "text") and shape.text.strip():
                        slide_text.append(shape.text)

                    # Extract text from tables
                    if shape.has_table:
                        for row in shape.table.rows:
                            row_text = []
                            for cell in row.cells:
                                if cell.text.strip():
                                    row_text.append(cell.text.strip())
                            if row_text:
                                slide_text.append(" | ".join(row_text))

                if len(slide_text) > 1:  # More than just the slide header
                    text_parts.append("\n".join(slide_text))

            return "\n\n".join(text_parts)

        except DocumentParseError:
            raise
        except Exception as e:
            logger.error(f"Error parsing PowerPoint: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse PowerPoint: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_excel(self, binary_data: bytes, extension: str) -> str:
        """Parse Excel file and extract text."""
        try:
            if extension == ".xls":
                raise DocumentParseError(
                    "Legacy .xls format is not fully supported. Please convert to .xlsx",
                    DocumentParseError.LEGACY_XLS,
                )

            from openpyxl import load_workbook

            excel_file = io.BytesIO(binary_data)
            wb = load_workbook(excel_file, read_only=True, data_only=True)

            text_parts = []
            for sheet_name in wb.sheetnames:
                sheet = wb[sheet_name]
                sheet_text = [f"--- Sheet: {sheet_name} ---"]

                for row in sheet.iter_rows():
                    row_values = []
                    for cell in row:
                        if cell.value is not None:
                            row_values.append(str(cell.value))
                    if row_values:
                        sheet_text.append(" | ".join(row_values))

                if len(sheet_text) > 1:
                    text_parts.append("\n".join(sheet_text))

            wb.close()
            return "\n\n".join(text_parts)

        except DocumentParseError:
            raise
        except Exception as e:
            logger.error(f"Error parsing Excel: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse Excel: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_csv(self, binary_data: bytes) -> str:
        """Parse CSV file and extract text."""
        try:
            # Detect encoding
            detected = chardet.detect(binary_data)
            encoding = detected.get("encoding", "utf-8") or "utf-8"

            text = binary_data.decode(encoding)
            csv_file = io.StringIO(text)

            reader = csv.reader(csv_file)
            rows = []
            for row in reader:
                if any(cell.strip() for cell in row):
                    rows.append(" | ".join(cell.strip() for cell in row))

            return "\n".join(rows)

        except Exception as e:
            logger.error(f"Error parsing CSV: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse CSV: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_text(self, binary_data: bytes) -> str:
        """Parse plain text or markdown file."""
        # Try common encodings in order of preference
        encodings_to_try = ["utf-8", "utf-8-sig", "gbk", "gb2312", "gb18030", "latin-1"]

        # First, try to detect encoding using chardet
        try:
            detected = chardet.detect(binary_data)
            detected_encoding = detected.get("encoding")
            if detected_encoding and detected_encoding.lower() not in [
                "ascii",
                "charmap",
            ]:
                # Insert detected encoding at the beginning if it's valid
                encodings_to_try.insert(0, detected_encoding)
        except Exception:
            pass  # Ignore chardet errors

        # Try each encoding
        last_error = None
        for encoding in encodings_to_try:
            try:
                return binary_data.decode(encoding)
            except (UnicodeDecodeError, LookupError) as e:
                last_error = e
                continue

        # If all encodings fail, try with error handling
        try:
            return binary_data.decode("utf-8", errors="replace")
        except Exception as e:
            logger.error(f"Error parsing text file: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse text file: {str(last_error or e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_image(self, binary_data: bytes, extension: str) -> Tuple[str, str]:
        """
        Parse image file and return metadata information with base64 encoding.

        Returns:
            Tuple of (metadata_text, base64_encoded_image)
        """
        try:
            from PIL import Image

            image_file = io.BytesIO(binary_data)
            img = Image.open(image_file)

            # Extract image metadata
            width, height = img.size
            mode = img.mode
            format_name = img.format or extension[1:].upper()

            # Build description
            text = f"[图片文件]\n"
            text += f"格式: {format_name}\n"
            text += f"尺寸: {width} x {height} 像素\n"
            text += f"颜色模式: {mode}\n"
            text += f"文件大小: {len(binary_data)} 字节"

            # Try to extract EXIF data if available
            if hasattr(img, "_getexif") and img._getexif():
                text += "\n\n[EXIF 信息]"
                exif_data = img._getexif()
                if exif_data:
                    # Just mention EXIF is available, don't extract all
                    text += "\n包含 EXIF 元数据"

            # Encode image to base64 for vision models
            image_base64 = base64.b64encode(binary_data).decode("utf-8")

            return text, image_base64

        except Exception as e:
            logger.error(f"Error parsing image: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse image: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e


# Global parser instance
document_parser = DocumentParser()
