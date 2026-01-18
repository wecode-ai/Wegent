# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document parser service using unstructured library.

Supports all document formats with built-in OCR:
- PDF (native text + scanned pages + embedded images)
- Word (.docx)
- PowerPoint (.pptx)
- Excel (.xlsx, .csv)
- Images (.jpg, .jpeg, .png, .gif, .bmp, .webp) with OCR
- Plain text (.txt, .md) and code files

OCR powered by Tesseract, supporting: English, Chinese (Simplified/Traditional),
Japanese, Korean.

Features smart truncation that preserves document structure:
- Excel/CSV: Header + uniformly sampled rows (covering entire dataset)
- PDF: First pages + uniformly sampled middle pages + last pages
- Word: Opening paragraphs + uniformly sampled middle + closing paragraphs
- PowerPoint: First/last slides + uniformly sampled middle slides
- Text/Markdown: Head content + uniformly sampled middle + tail content

MIME-based text file detection:
- Uses python-magic to detect actual file content type
- Supports text/* MIME types and common application/* text formats
- Allows uploading code files (.py, .js, .java, etc.) without explicit extension whitelist
"""

import base64
import io
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

import magic
from PIL import Image

from app.core.config import settings
from app.services.attachment.smart_truncation import (
    SmartTruncationConfig,
    SmartTruncationInfo,
    SmartTruncationManager,
    TruncationType,
)

logger = logging.getLogger(__name__)


# MIME types that are considered text-based files
# These files can be parsed as plain text
TEXT_MIME_TYPES: Set[str] = {
    # text/* family
    "text/plain",
    "text/html",
    "text/css",
    "text/javascript",
    "text/xml",
    "text/csv",
    "text/markdown",
    "text/x-python",
    "text/x-java",
    "text/x-c",
    "text/x-c++",
    "text/x-ruby",
    "text/x-perl",
    "text/x-php",
    "text/x-shellscript",
    "text/x-script.python",
    "text/x-go",
    "text/x-rust",
    "text/x-swift",
    "text/x-kotlin",
    "text/x-scala",
    "text/x-typescript",
    "text/x-coffeescript",
    "text/x-lua",
    "text/x-r",
    "text/x-matlab",
    "text/x-sql",
    "text/x-yaml",
    "text/x-toml",
    "text/x-ini",
    "text/x-properties",
    "text/x-diff",
    "text/x-patch",
    "text/x-log",
    "text/x-makefile",
    "text/x-cmake",
    "text/x-dockerfile",
    "text/x-nginx-conf",
    "text/x-apache-conf",
    "text/x-systemd-unit",
    "text/x-tex",
    "text/x-latex",
    "text/x-bibtex",
    "text/x-rst",
    "text/x-asciidoc",
    "text/x-org",
    "text/troff",
    "text/rtf",
    "text/calendar",
    "text/vcard",
    # application/* text-based types
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/x-sh",
    "application/x-bash",
    "application/x-csh",
    "application/x-zsh",
    "application/x-python",
    "application/x-ruby",
    "application/x-perl",
    "application/x-php",
    "application/sql",
    "application/graphql",
    "application/toml",
    "application/x-yaml",
    "application/yaml",
    "application/x-httpd-php",
    "application/x-typescript",
    "application/typescript",
    "application/x-tex",
    "application/x-latex",
    "application/x-troff",
    "application/x-troff-man",
    "application/x-ndjson",
    "application/ld+json",
    "application/manifest+json",
    "application/schema+json",
    "application/vnd.api+json",
    "application/hal+json",
    "application/problem+json",
    "application/x-www-form-urlencoded",
    "application/xhtml+xml",
    "application/atom+xml",
    "application/rss+xml",
    "application/soap+xml",
    "application/mathml+xml",
    "application/xslt+xml",
    "application/x-subrip",
    "application/x-wine-extension-ini",
}


@dataclass
class TruncationInfo:
    """Information about content truncation."""

    is_truncated: bool = False
    original_length: Optional[int] = None
    truncated_length: Optional[int] = None

    # Smart truncation details
    truncation_type: str = "none"  # "none", "simple", "smart"
    original_structure: Dict[str, Any] = field(default_factory=dict)
    kept_structure: Dict[str, Any] = field(default_factory=dict)
    summary_message: str = ""

    @classmethod
    def from_smart_info(cls, smart_info: SmartTruncationInfo) -> "TruncationInfo":
        """Create TruncationInfo from SmartTruncationInfo."""
        return cls(
            is_truncated=smart_info.is_truncated,
            original_length=smart_info.original_length,
            truncated_length=smart_info.truncated_length,
            truncation_type=smart_info.truncation_type.value,
            original_structure=smart_info.original_structure,
            kept_structure=smart_info.kept_structure,
            summary_message=smart_info.summary_message,
        )


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
    UNRECOGNIZED_TYPE = "unrecognized_type"
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
    Unified document parser based on unstructured library.

    Features:
    - Single library handles all document formats
    - Built-in OCR for images and scanned PDFs
    - Automatic embedded image extraction and OCR
    - Multi-language support (en, zh, ja, ko)
    - Smart truncation preserving document structure

    Supported formats:
    - PDF (.pdf)
    - Word (.docx)
    - PowerPoint (.pptx)
    - Excel (.xlsx, .csv)
    - Plain text (.txt)
    - Markdown (.md)
    - Images (.jpg, .jpeg, .png, .gif, .bmp, .webp)
    - Any text-based files detected via MIME type analysis
    """

    # OCR configuration defaults
    DEFAULT_OCR_LANGUAGES = ["eng", "chi_sim", "chi_tra", "jpn", "kor"]

    # File type categories
    IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
    PDF_EXTENSION = {".pdf"}
    OFFICE_EXTENSIONS = {".docx", ".pptx", ".xlsx"}
    TEXT_EXTENSIONS = {".txt", ".md", ".csv"}
    LEGACY_EXTENSIONS = {".doc", ".ppt", ".xls"}

    # Supported file extensions and their MIME types (known formats)
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

    # Special format extensions that have dedicated parsers
    SPECIAL_FORMAT_EXTENSIONS = {
        ".pdf",
        ".doc",
        ".docx",
        ".ppt",
        ".pptx",
        ".xls",
        ".xlsx",
        ".csv",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".bmp",
        ".webp",
    }

    # Known text format extensions (no MIME detection needed)
    KNOWN_TEXT_EXTENSIONS = {".txt", ".md"}

    def __init__(self, truncation_config: Optional[SmartTruncationConfig] = None):
        """
        Initialize DocumentParser with optional truncation configuration.

        Args:
            truncation_config: Configuration for smart truncation.
                              If None, uses default configuration.
        """
        self.truncation_manager = SmartTruncationManager(truncation_config)
        self.ocr_enabled = settings.OCR_ENABLED
        self.ocr_languages = self._parse_ocr_languages()
        self.ocr_strategy = settings.OCR_STRATEGY

    def _parse_ocr_languages(self) -> List[str]:
        """Parse OCR languages from settings."""
        if settings.OCR_LANGUAGES:
            return settings.OCR_LANGUAGES.split("+")
        return self.DEFAULT_OCR_LANGUAGES

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
        """
        Check if the file extension is supported.

        For known extensions, returns True if in SUPPORTED_EXTENSIONS.
        For unknown extensions, returns True to allow MIME-based detection.
        """
        ext = extension.lower()
        # Known extensions are always supported
        if ext in cls.SUPPORTED_EXTENSIONS:
            return True
        # For unknown extensions, we allow them to proceed
        # The parse() method will use MIME detection to validate
        return True

    @classmethod
    def is_known_extension(cls, extension: str) -> bool:
        """Check if the extension is in the known formats list."""
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

    @staticmethod
    def detect_mime_type(binary_data: bytes) -> str:
        """
        Detect the MIME type of file content using python-magic.

        Args:
            binary_data: File binary content

        Returns:
            Detected MIME type string (e.g., 'text/plain', 'application/json')
        """
        try:
            mime = magic.Magic(mime=True)
            mime_type = mime.from_buffer(binary_data)
            return mime_type
        except Exception as e:
            logger.warning(f"Failed to detect MIME type: {e}")
            return "application/octet-stream"

    @staticmethod
    def is_text_mime_type(mime_type: Optional[str]) -> bool:
        """
        Check if a MIME type represents a text-based file.

        Args:
            mime_type: MIME type string to check, or None

        Returns:
            True if the MIME type is text-based, False otherwise
        """
        if not mime_type:
            return False

        # Check if it starts with text/
        if mime_type.startswith("text/"):
            return True

        # Check if it's in our whitelist of text-based application/* types
        if mime_type in TEXT_MIME_TYPES:
            return True

        # Check for common text-based patterns
        # Many text formats use +json, +xml suffixes
        if mime_type.endswith("+json") or mime_type.endswith("+xml"):
            return True

        return False

    def _get_legacy_error_code(self, extension: str) -> str:
        """Get error code for legacy format extensions."""
        ext = extension.lower()
        if ext == ".doc":
            return DocumentParseError.LEGACY_DOC
        elif ext == ".ppt":
            return DocumentParseError.LEGACY_PPT
        elif ext == ".xls":
            return DocumentParseError.LEGACY_XLS
        return DocumentParseError.UNSUPPORTED_TYPE

    def parse(
        self,
        binary_data: bytes,
        extension: str,
        use_smart_truncation: bool = True,
    ) -> ParseResult:
        """
        Parse document and extract text content with smart truncation.

        Args:
            binary_data: File binary data
            extension: File extension (e.g., '.pdf', '.docx')
            use_smart_truncation: Whether to use smart truncation (default: True).
                                 If False, falls back to simple text cutting.

        Returns:
            ParseResult with extracted text, length, optional image_base64,
            and truncation_info if content was truncated

        Raises:
            DocumentParseError: If parsing fails
        """
        extension = extension.lower()
        max_length = self.get_max_text_length()

        try:
            # Handle legacy formats with user-friendly message
            if extension in self.LEGACY_EXTENSIONS:
                raise DocumentParseError(
                    f"Legacy {extension} format not supported. Please convert to modern format.",
                    self._get_legacy_error_code(extension),
                )

            # Route to appropriate parser
            if extension in self.IMAGE_EXTENSIONS:
                return self._parse_image(
                    binary_data, extension, max_length, use_smart_truncation
                )
            elif extension in self.PDF_EXTENSION:
                return self._parse_pdf(
                    binary_data, max_length, use_smart_truncation
                )
            elif extension in self.OFFICE_EXTENSIONS:
                return self._parse_office(
                    binary_data, extension, max_length, use_smart_truncation
                )
            elif extension in self.TEXT_EXTENSIONS:
                return self._parse_text(
                    binary_data, extension, max_length, use_smart_truncation
                )

            # For unknown extensions, use MIME detection
            mime_type = self.detect_mime_type(binary_data)
            logger.info(
                f"Detected MIME type '{mime_type}' for file with extension '{extension}'"
            )

            if self.is_text_mime_type(mime_type):
                return self._parse_text(
                    binary_data, extension, max_length, use_smart_truncation
                )
            else:
                raise DocumentParseError(
                    f"Unrecognized file type: {extension} (detected MIME: {mime_type})",
                    DocumentParseError.UNRECOGNIZED_TYPE,
                )

        except DocumentParseError:
            raise
        except Exception as e:
            logger.error(f"Error parsing document: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse document: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_image(
        self,
        binary_data: bytes,
        extension: str,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """
        Parse image with OCR text extraction.

        Args:
            binary_data: Image binary data
            extension: File extension
            max_length: Maximum text length
            use_smart_truncation: Whether to use smart truncation

        Returns:
            ParseResult with metadata, OCR text, and base64 encoded image
        """
        # Extract image metadata using PIL
        img = Image.open(io.BytesIO(binary_data))
        metadata = self._get_image_metadata(img, binary_data, extension)

        # OCR text extraction using unstructured
        ocr_text = ""
        if self.ocr_enabled:
            ocr_text = self._extract_image_ocr(binary_data)

        # Combine metadata and OCR text
        text = metadata
        if ocr_text:
            text += f"\n\n[OCR Recognized Text / OCR 识别文字]\n{ocr_text}"

        # Apply truncation if needed
        truncation_info = None
        if use_smart_truncation and len(text) > max_length:
            text, smart_info = self.truncation_manager.truncate_text(text, max_length)
            if smart_info.is_truncated:
                truncation_info = TruncationInfo.from_smart_info(smart_info)
        elif not use_smart_truncation and len(text) > max_length:
            original_length = len(text)
            text = text[:max_length]
            truncation_info = TruncationInfo(
                is_truncated=True,
                original_length=original_length,
                truncated_length=max_length,
                truncation_type="simple",
            )

        # Encode image for vision models
        image_base64 = base64.b64encode(binary_data).decode("utf-8")

        return ParseResult(
            text=text,
            text_length=len(text),
            image_base64=image_base64,
            truncation_info=truncation_info,
        )

    def _get_image_metadata(
        self, img: Image.Image, binary_data: bytes, extension: str
    ) -> str:
        """Extract image metadata as formatted text."""
        width, height = img.size
        mode = img.mode
        format_name = img.format or extension[1:].upper()

        text = f"[Image File / 图片文件]\n"
        text += f"Format / 格式: {format_name}\n"
        text += f"Dimensions / 尺寸: {width} x {height} pixels\n"
        text += f"Color Mode / 颜色模式: {mode}\n"
        text += f"File Size / 文件大小: {len(binary_data)} bytes"

        # Try to extract EXIF data if available
        if hasattr(img, "_getexif") and img._getexif():
            text += "\n\n[EXIF Info / EXIF 信息]"
            text += "\nContains EXIF metadata / 包含 EXIF 元数据"

        return text

    def _extract_image_ocr(self, binary_data: bytes) -> str:
        """
        Extract text from image using unstructured OCR.

        Args:
            binary_data: Image binary data

        Returns:
            Extracted OCR text, or empty string on failure
        """
        try:
            from unstructured.partition.image import partition_image

            elements = partition_image(
                file=io.BytesIO(binary_data),
                languages=self.ocr_languages,
                strategy="ocr_only",
            )
            return "\n".join(
                [el.text for el in elements if el.text and el.text.strip()]
            )
        except Exception as e:
            logger.warning(f"OCR extraction failed for image: {e}")
            return ""

    def _parse_pdf(
        self,
        binary_data: bytes,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """
        Parse PDF with automatic OCR for scanned pages and embedded images.

        Args:
            binary_data: PDF binary data
            max_length: Maximum text length
            use_smart_truncation: Whether to use smart truncation

        Returns:
            ParseResult with extracted text and truncation info
        """
        try:
            from unstructured.partition.pdf import partition_pdf

            # Determine parsing strategy based on OCR settings
            strategy = self.ocr_strategy if self.ocr_enabled else "fast"

            elements = partition_pdf(
                file=io.BytesIO(binary_data),
                languages=self.ocr_languages if self.ocr_enabled else None,
                strategy=strategy,
                extract_images_in_pdf=self.ocr_enabled,
                infer_table_structure=True,
            )

            # Group elements by page for smart truncation
            pages_text = self._group_elements_by_page(elements)

            # Apply smart truncation at page level
            truncation_info = None
            if use_smart_truncation:
                text, smart_info = self.truncation_manager.truncate_pdf(
                    pages_text, max_length
                )
                if smart_info.is_truncated:
                    truncation_info = TruncationInfo.from_smart_info(smart_info)
            else:
                text = "\n\n".join(pages_text)
                if len(text) > max_length:
                    original_length = len(text)
                    text = text[:max_length]
                    truncation_info = TruncationInfo(
                        is_truncated=True,
                        original_length=original_length,
                        truncated_length=max_length,
                        truncation_type="simple",
                    )

            return ParseResult(
                text=text,
                text_length=len(text),
                truncation_info=truncation_info,
            )

        except Exception as e:
            error_str = str(e).lower()
            if "encrypted" in error_str or "password" in error_str:
                raise DocumentParseError(
                    "Cannot parse encrypted PDF file",
                    DocumentParseError.ENCRYPTED_PDF,
                )
            logger.error(f"Error parsing PDF: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse PDF: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _parse_office(
        self,
        binary_data: bytes,
        extension: str,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """
        Parse Office documents (docx, pptx, xlsx) with embedded image OCR.

        Args:
            binary_data: Document binary data
            extension: File extension (.docx, .pptx, .xlsx)
            max_length: Maximum text length
            use_smart_truncation: Whether to use smart truncation

        Returns:
            ParseResult with extracted text and truncation info
        """
        try:
            from unstructured.partition.auto import partition

            elements = partition(
                file=io.BytesIO(binary_data),
                languages=self.ocr_languages if self.ocr_enabled else None,
                extract_image_block_to_payload=self.ocr_enabled,
            )

            # Apply format-specific smart truncation
            truncation_info = None
            if extension == ".docx":
                return self._process_word_elements(
                    elements, max_length, use_smart_truncation
                )
            elif extension == ".pptx":
                return self._process_powerpoint_elements(
                    elements, max_length, use_smart_truncation
                )
            elif extension == ".xlsx":
                return self._process_excel_elements(
                    elements, max_length, use_smart_truncation
                )
            else:
                # Fallback for any other office format
                text = self._elements_to_text(elements)
                if len(text) > max_length:
                    if use_smart_truncation:
                        text, smart_info = self.truncation_manager.truncate_text(
                            text, max_length
                        )
                        if smart_info.is_truncated:
                            truncation_info = TruncationInfo.from_smart_info(smart_info)
                    else:
                        original_length = len(text)
                        text = text[:max_length]
                        truncation_info = TruncationInfo(
                            is_truncated=True,
                            original_length=original_length,
                            truncated_length=max_length,
                            truncation_type="simple",
                        )

                return ParseResult(
                    text=text,
                    text_length=len(text),
                    truncation_info=truncation_info,
                )

        except Exception as e:
            logger.error(f"Error parsing {extension}: {e}", exc_info=True)
            raise DocumentParseError(
                f"Failed to parse {extension}: {str(e)}",
                DocumentParseError.PARSE_FAILED,
            ) from e

    def _process_word_elements(
        self,
        elements: List,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """Process Word document elements with paragraph-based truncation."""
        paragraphs = [el.text for el in elements if el.text and el.text.strip()]

        truncation_info = None
        if use_smart_truncation:
            text, smart_info = self.truncation_manager.truncate_word(
                paragraphs, max_length
            )
            if smart_info.is_truncated:
                truncation_info = TruncationInfo.from_smart_info(smart_info)
        else:
            text = "\n\n".join(paragraphs)
            if len(text) > max_length:
                original_length = len(text)
                text = text[:max_length]
                truncation_info = TruncationInfo(
                    is_truncated=True,
                    original_length=original_length,
                    truncated_length=max_length,
                    truncation_type="simple",
                )

        return ParseResult(
            text=text,
            text_length=len(text),
            truncation_info=truncation_info,
        )

    def _process_powerpoint_elements(
        self,
        elements: List,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """Process PowerPoint elements with slide-based truncation."""
        # Group elements by slide (page_number in metadata)
        slides_text = self._group_elements_by_page(elements)

        # Format slides with headers
        formatted_slides = []
        for i, slide_text in enumerate(slides_text, 1):
            formatted_slides.append(f"--- Slide {i} ---\n{slide_text}")

        truncation_info = None
        if use_smart_truncation:
            text, smart_info = self.truncation_manager.truncate_powerpoint(
                formatted_slides, max_length
            )
            if smart_info.is_truncated:
                truncation_info = TruncationInfo.from_smart_info(smart_info)
        else:
            text = "\n\n".join(formatted_slides)
            if len(text) > max_length:
                original_length = len(text)
                text = text[:max_length]
                truncation_info = TruncationInfo(
                    is_truncated=True,
                    original_length=original_length,
                    truncated_length=max_length,
                    truncation_type="simple",
                )

        return ParseResult(
            text=text,
            text_length=len(text),
            truncation_info=truncation_info,
        )

    def _process_excel_elements(
        self,
        elements: List,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """Process Excel elements with row-based truncation."""
        # Convert elements to sheet-based structure
        sheets_data = self._elements_to_sheets(elements)

        truncation_info = None
        if use_smart_truncation:
            text, smart_info = self.truncation_manager.truncate_excel(
                sheets_data, max_length
            )
            if smart_info.is_truncated:
                truncation_info = TruncationInfo.from_smart_info(smart_info)
        else:
            # Format sheets without smart truncation
            text_parts = []
            for sheet in sheets_data:
                sheet_text = [f"--- Sheet: {sheet['name']} ---"]
                for row in sheet["rows"]:
                    row_str = " | ".join(
                        str(cell) if cell is not None else "" for cell in row
                    )
                    if row_str.strip():
                        sheet_text.append(row_str)
                text_parts.append("\n".join(sheet_text))
            text = "\n\n".join(text_parts)

            if len(text) > max_length:
                original_length = len(text)
                text = text[:max_length]
                truncation_info = TruncationInfo(
                    is_truncated=True,
                    original_length=original_length,
                    truncated_length=max_length,
                    truncation_type="simple",
                )

        return ParseResult(
            text=text,
            text_length=len(text),
            truncation_info=truncation_info,
        )

    def _parse_text(
        self,
        binary_data: bytes,
        extension: str,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """
        Parse text files with encoding detection.

        Args:
            binary_data: File binary data
            extension: File extension
            max_length: Maximum text length
            use_smart_truncation: Whether to use smart truncation

        Returns:
            ParseResult with extracted text and truncation info
        """
        try:
            from unstructured.partition.auto import partition

            elements = partition(file=io.BytesIO(binary_data))
            text = "\n".join([el.text for el in elements if el.text])

            truncation_info = None
            if use_smart_truncation and len(text) > max_length:
                text, smart_info = self.truncation_manager.truncate_text(
                    text, max_length
                )
                if smart_info.is_truncated:
                    truncation_info = TruncationInfo.from_smart_info(smart_info)
            elif not use_smart_truncation and len(text) > max_length:
                original_length = len(text)
                text = text[:max_length]
                truncation_info = TruncationInfo(
                    is_truncated=True,
                    original_length=original_length,
                    truncated_length=max_length,
                    truncation_type="simple",
                )

            return ParseResult(
                text=text,
                text_length=len(text),
                truncation_info=truncation_info,
            )

        except Exception as e:
            # Fallback to direct decoding if unstructured fails
            logger.warning(
                f"Unstructured parsing failed for text file, using fallback: {e}"
            )
            return self._parse_text_fallback(
                binary_data, max_length, use_smart_truncation
            )

    def _parse_text_fallback(
        self,
        binary_data: bytes,
        max_length: int,
        use_smart_truncation: bool,
    ) -> ParseResult:
        """
        Fallback text parsing with manual encoding detection.

        Args:
            binary_data: File binary data
            max_length: Maximum text length
            use_smart_truncation: Whether to use smart truncation

        Returns:
            ParseResult with extracted text and truncation info
        """
        # Try common encodings in order of preference
        encodings_to_try = ["utf-8", "utf-8-sig", "gbk", "gb2312", "gb18030", "latin-1"]

        text = None
        for encoding in encodings_to_try:
            try:
                text = binary_data.decode(encoding)
                break
            except (UnicodeDecodeError, LookupError):
                continue

        if text is None:
            # Last resort: decode with replacement
            text = binary_data.decode("utf-8", errors="replace")

        truncation_info = None
        if use_smart_truncation and len(text) > max_length:
            text, smart_info = self.truncation_manager.truncate_text(text, max_length)
            if smart_info.is_truncated:
                truncation_info = TruncationInfo.from_smart_info(smart_info)
        elif not use_smart_truncation and len(text) > max_length:
            original_length = len(text)
            text = text[:max_length]
            truncation_info = TruncationInfo(
                is_truncated=True,
                original_length=original_length,
                truncated_length=max_length,
                truncation_type="simple",
            )

        return ParseResult(
            text=text,
            text_length=len(text),
            truncation_info=truncation_info,
        )

    def _elements_to_text(self, elements: List) -> str:
        """
        Convert unstructured elements to formatted text.

        Args:
            elements: List of unstructured elements

        Returns:
            Formatted text string
        """
        parts = []
        for el in elements:
            if el.text and el.text.strip():
                # Preserve element type information for better formatting
                category = getattr(el, "category", None)
                if category == "Table":
                    parts.append(f"\n{el.text}\n")
                elif category == "Title":
                    parts.append(f"\n## {el.text}\n")
                else:
                    parts.append(el.text)
        return "\n\n".join(parts)

    def _group_elements_by_page(self, elements: List) -> List[str]:
        """
        Group elements by page number for smart truncation.

        Args:
            elements: List of unstructured elements

        Returns:
            List of text strings, one per page
        """
        pages: Dict[int, List[str]] = {}
        for el in elements:
            # Get page number from metadata
            page_num = 0
            if hasattr(el, "metadata") and hasattr(el.metadata, "page_number"):
                page_num = el.metadata.page_number or 0

            if page_num not in pages:
                pages[page_num] = []
            if el.text and el.text.strip():
                pages[page_num].append(el.text)

        # Sort by page number and join texts
        sorted_pages = sorted(pages.items(), key=lambda x: x[0])
        return ["\n".join(texts) for _, texts in sorted_pages]

    def _elements_to_sheets(self, elements: List) -> List[Dict[str, Any]]:
        """
        Convert unstructured elements to Excel sheet structure.

        Args:
            elements: List of unstructured elements

        Returns:
            List of sheet dictionaries with 'name' and 'rows' keys
        """
        # Unstructured may not preserve sheet structure perfectly
        # Group by page_number as proxy for sheets
        sheets: Dict[int, Dict[str, Any]] = {}

        for el in elements:
            page_num = 0
            if hasattr(el, "metadata") and hasattr(el.metadata, "page_number"):
                page_num = el.metadata.page_number or 0

            if page_num not in sheets:
                sheets[page_num] = {
                    "name": f"Sheet{page_num + 1}",
                    "rows": [],
                }

            if el.text and el.text.strip():
                # Try to parse table-like content
                category = getattr(el, "category", None)
                if category == "Table":
                    # Split table rows by newline and cells by pipe or tab
                    for line in el.text.split("\n"):
                        if line.strip():
                            if "|" in line:
                                cells = [cell.strip() for cell in line.split("|")]
                            elif "\t" in line:
                                cells = [cell.strip() for cell in line.split("\t")]
                            else:
                                cells = [line.strip()]
                            sheets[page_num]["rows"].append(cells)
                else:
                    # Add as single-cell row
                    sheets[page_num]["rows"].append([el.text])

        # Return sheets in order
        sorted_sheets = sorted(sheets.items(), key=lambda x: x[0])
        return [sheet for _, sheet in sorted_sheets]


# Global parser instance
document_parser = DocumentParser()
