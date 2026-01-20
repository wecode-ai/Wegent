# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API document structure detector.

This module implements Phase 5.5 of the document processing pipeline:
detecting API documentation patterns and extracting structured API sections
with support for multiple endpoints sharing parameters, responses, and examples.
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from ..models.api_models import APIDocumentInfo, APIEndpoint, APISection
from ..models.ir import BlockType, StructureBlock

logger = logging.getLogger(__name__)


class APIStructureDetector:
    """
    API document structure detector with multi-endpoint support.

    Detects API documentation patterns and extracts:
    - API endpoints (HTTP method + path)
    - Shared parameters across multiple endpoints
    - Shared response descriptions
    - Shared examples and code blocks

    Supports common documentation patterns:
    1. Single endpoint with its own params/response/examples
    2. Multiple endpoints sharing params/response/examples
    3. Heading + description + endpoint(s) patterns
    """

    # Patterns for detecting HTTP endpoints
    ENDPOINT_PATTERNS: List[Tuple[re.Pattern, int]] = [
        # Standard HTTP methods + path
        (
            re.compile(
                r"^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([/\w\-\{\}:\.]+)",
                re.IGNORECASE,
            ),
            re.IGNORECASE,
        ),
        # Method with colon separator
        (
            re.compile(
                r"^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)[:：]\s*([/\w\-\{\}:\.]+)",
                re.IGNORECASE,
            ),
            re.IGNORECASE,
        ),
    ]

    # Keywords indicating request parameters section
    PARAMS_INDICATORS: List[str] = [
        "请求参数",
        "入参",
        "参数说明",
        "参数列表",
        "请求体",
        "request param",
        "query param",
        "path param",
        "body param",
        "header param",
        "input",
        "parameters",
        "params",
    ]

    # Keywords indicating response section
    RESPONSE_INDICATORS: List[str] = [
        "返回",
        "响应",
        "输出",
        "返回参数",
        "返回字段",
        "响应字段",
        "返回值",
        "返回结果",
        "response",
        "return",
        "output",
        "result",
    ]

    # Keywords indicating examples section
    EXAMPLE_INDICATORS: List[str] = [
        "示例",
        "样例",
        "example",
        "sample",
    ]

    def __init__(self):
        """Initialize the API structure detector."""
        # Compile indicator patterns for efficient matching
        self._params_pattern = re.compile(
            "|".join(re.escape(ind) for ind in self.PARAMS_INDICATORS),
            re.IGNORECASE,
        )
        self._response_pattern = re.compile(
            "|".join(re.escape(ind) for ind in self.RESPONSE_INDICATORS),
            re.IGNORECASE,
        )
        self._example_pattern = re.compile(
            "|".join(re.escape(ind) for ind in self.EXAMPLE_INDICATORS),
            re.IGNORECASE,
        )

    def detect(self, blocks: List[StructureBlock]) -> APIDocumentInfo:
        """
        Detect API structure in document blocks.

        Args:
            blocks: List of structure blocks from document IR

        Returns:
            APIDocumentInfo with detected API sections
        """
        if not blocks:
            return APIDocumentInfo(is_api_doc=False)

        api_sections: List[APISection] = []
        current_section: Optional[APISection] = None

        i = 0
        while i < len(blocks):
            block = blocks[i]

            # Try to detect a new API section start
            section_start_info = self._detect_section_start(blocks, i)
            if section_start_info:
                # Save previous section if it has content
                if current_section and (
                    current_section.endpoints or current_section.shared_params_blocks
                ):
                    api_sections.append(current_section)

                # Create new section
                current_section = APISection(
                    heading_block=section_start_info.get("heading_block")
                )

                # Add detected endpoints
                for ep_info in section_start_info.get("endpoints", []):
                    current_section.endpoints.append(
                        APIEndpoint(
                            block_index=ep_info["block_index"],
                            method=ep_info["method"],
                            path=ep_info["path"],
                            description_blocks=ep_info.get("description_blocks", []),
                        )
                    )

                # Skip to the next unprocessed block
                i = section_start_info.get("next_index", i + 1)
                continue

            # No current section, skip this block
            if current_section is None:
                i += 1
                continue

            # Check if current block is an additional endpoint
            endpoint_info = self._parse_endpoint(block)
            if endpoint_info:
                current_section.endpoints.append(
                    APIEndpoint(
                        block_index=i,
                        method=endpoint_info["method"],
                        path=endpoint_info["path"],
                    )
                )
                i += 1
                continue

            # Classify the block (params, response, example, or description)
            classified = self._classify_block(block, blocks, i, current_section)

            if classified == "params":
                current_section.shared_params_blocks.append(i)
            elif classified == "response":
                current_section.shared_response_blocks.append(i)
            elif classified == "example":
                current_section.shared_example_blocks.append(i)
            elif classified == "description":
                # Determine if description is endpoint-specific or shared
                if self._is_endpoint_specific_description(
                    block, blocks, i, current_section
                ):
                    # Attach to the most recent endpoint
                    if current_section.endpoints:
                        current_section.endpoints[-1].description_blocks.append(i)
                    else:
                        current_section.shared_description_blocks.append(i)
                else:
                    current_section.shared_description_blocks.append(i)

            i += 1

        # Save the last section
        if current_section and (
            current_section.endpoints or current_section.shared_params_blocks
        ):
            api_sections.append(current_section)

        # Determine if this is an API document
        is_api_doc = len(api_sections) > 0 and any(
            len(s.endpoints) > 0 for s in api_sections
        )

        result = APIDocumentInfo(is_api_doc=is_api_doc, api_sections=api_sections)

        # Log detection results
        self._log_detection_results(result)

        return result

    def _detect_section_start(
        self,
        blocks: List[StructureBlock],
        index: int,
    ) -> Optional[Dict[str, Any]]:
        """
        Detect the start of an API section.

        Supports patterns:
        1. heading + endpoint(s)
        2. heading + description + endpoint(s)
        3. heading + endpoint + description + endpoint + description (alternating)
        4. Consecutive endpoints (treated as one section)

        Returns:
            Dictionary with heading_block, endpoints (with descriptions), and next_index
        """
        block = blocks[index]

        # Pattern 1, 2, 3: Section starts with heading
        if block.type == BlockType.HEADING:
            endpoints = []
            pending_descriptions = []  # Descriptions waiting to be assigned
            lookahead_limit = min(index + 12, len(blocks))
            last_index = index

            j = index + 1
            while j < lookahead_limit:
                current_block = blocks[j]

                # Stop at next heading
                if current_block.type == BlockType.HEADING:
                    break

                # Try to parse as endpoint
                ep_info = self._parse_endpoint(current_block)
                if ep_info:
                    # If we have pending descriptions and this is the first endpoint,
                    # they're section descriptions, not endpoint-specific
                    # If we have a previous endpoint, assign pending descriptions to it
                    if endpoints and pending_descriptions:
                        endpoints[-1]["description_blocks"] = pending_descriptions
                    pending_descriptions = []

                    endpoints.append(
                        {
                            "block_index": j,
                            "method": ep_info["method"],
                            "path": ep_info["path"],
                            "description_blocks": [],
                        }
                    )
                    last_index = j
                elif endpoints and self._could_be_endpoint_description(current_block):
                    # This might be a description for the current endpoint
                    # or there might be more endpoints coming
                    has_more_endpoints = False
                    for k in range(j + 1, min(j + 3, lookahead_limit)):
                        if blocks[k].type == BlockType.HEADING:
                            break
                        if self._parse_endpoint(blocks[k]):
                            has_more_endpoints = True
                            break

                    if has_more_endpoints:
                        # This description belongs to the current endpoint
                        endpoints[-1]["description_blocks"].append(j)
                        last_index = j
                    else:
                        # No more endpoints, this description belongs to current endpoint
                        endpoints[-1]["description_blocks"].append(j)
                        last_index = j
                        # But stop scanning for more endpoints
                        break
                elif not endpoints:
                    # No endpoints yet, continue scanning
                    pass
                else:
                    # Non-description non-endpoint block after finding endpoints
                    break

                j += 1

            if endpoints:
                return {
                    "heading_block": index,
                    "endpoints": endpoints,
                    "next_index": last_index + 1,
                }

        # Pattern 4: Direct endpoint without heading
        ep_info = self._parse_endpoint(block)
        if ep_info:
            endpoints = [
                {
                    "block_index": index,
                    "method": ep_info["method"],
                    "path": ep_info["path"],
                    "description_blocks": [],
                }
            ]
            last_index = index

            # Check for consecutive endpoints (with possible descriptions between)
            j = index + 1
            lookahead_limit = min(index + 10, len(blocks))
            while j < lookahead_limit:
                current_block = blocks[j]
                next_ep = self._parse_endpoint(current_block)
                if next_ep:
                    endpoints.append(
                        {
                            "block_index": j,
                            "method": next_ep["method"],
                            "path": next_ep["path"],
                            "description_blocks": [],
                        }
                    )
                    last_index = j
                elif self._could_be_endpoint_description(current_block):
                    # Check if there's another endpoint after this description
                    has_more_endpoints = False
                    for k in range(j + 1, min(j + 3, lookahead_limit)):
                        if self._parse_endpoint(blocks[k]):
                            has_more_endpoints = True
                            break

                    # Assign to current endpoint
                    endpoints[-1]["description_blocks"].append(j)
                    last_index = j

                    if not has_more_endpoints:
                        break
                else:
                    break
                j += 1

            return {
                "heading_block": None,
                "endpoints": endpoints,
                "next_index": last_index + 1,
            }

        return None

    def _could_be_endpoint_description(self, block: StructureBlock) -> bool:
        """
        Check if a block could be an endpoint-specific description.

        Short paragraphs between endpoints are likely descriptions.
        """
        if block.type != BlockType.PARAGRAPH:
            return False

        content = block.content.strip()
        # Short text is likely a description
        if len(content) < 150:
            return True

        return False

    def _parse_endpoint(self, block: StructureBlock) -> Optional[Dict[str, str]]:
        """
        Parse a block as an API endpoint.

        Returns:
            {"method": "GET", "path": "/api/v1/users"} or None
        """
        # Only check paragraph blocks for endpoints
        if block.type not in {BlockType.PARAGRAPH, BlockType.CODE}:
            return None

        content = block.content.strip()

        # Skip empty or very short content
        if len(content) < 5:
            return None

        # Try to match endpoint patterns
        for pattern, _ in self.ENDPOINT_PATTERNS:
            match = pattern.match(content)
            if match:
                method = match.group(1).upper()
                path = match.group(2).strip()

                # Validate path looks like an API path
                if path.startswith("/") or path.startswith("{"):
                    return {"method": method, "path": path}

        return None

    def _classify_block(
        self,
        block: StructureBlock,
        blocks: List[StructureBlock],
        index: int,
        current_section: APISection,
    ) -> str:
        """
        Classify a block as params, response, example, description, or other.

        Uses position awareness to correctly classify blocks.

        Returns:
            "params" | "response" | "example" | "description" | "other"
        """
        # Code blocks are typically examples
        if block.type == BlockType.CODE:
            return "example"

        # Tables need context-aware classification
        if block.type == BlockType.TABLE:
            return self._classify_table(block, blocks, index, current_section)

        # Paragraphs: check if they're labels or descriptions
        if block.type == BlockType.PARAGRAPH:
            content_lower = block.content.lower()

            # Check if this is a section label
            if len(block.content.strip()) < 50:  # Short text might be a label
                if self._params_pattern.search(content_lower):
                    return "other"  # This is a label, not content
                if self._response_pattern.search(content_lower):
                    return "other"
                if self._example_pattern.search(content_lower):
                    return "other"

            return "description"

        # Lists might be parameter descriptions
        if block.type == BlockType.LIST:
            return self._classify_list(block, blocks, index, current_section)

        return "other"

    def _classify_table(
        self,
        block: StructureBlock,
        blocks: List[StructureBlock],
        index: int,
        current_section: APISection,
    ) -> str:
        """
        Classify a table block based on context.

        Returns:
            "params" | "response"
        """
        # Check preceding block for context
        if index > 0:
            prev_block = blocks[index - 1]
            prev_content = prev_block.content.lower()

            # Check for response indicators first
            if self._response_pattern.search(prev_content):
                return "response"

            # Check for params indicators
            if self._params_pattern.search(prev_content):
                return "params"

        # Check table headers if available
        if block.headers:
            header_text = " ".join(block.headers).lower()
            if any(
                kw in header_text
                for kw in ["返回", "response", "output", "输出", "结果"]
            ):
                return "response"
            if any(kw in header_text for kw in ["参数", "param", "field", "字段"]):
                return "params"

        # Position-based heuristic: if we already have params, this might be response
        if current_section.shared_params_blocks:
            return "response"

        # Default: first table is usually params
        return "params"

    def _classify_list(
        self,
        block: StructureBlock,
        blocks: List[StructureBlock],
        index: int,
        current_section: APISection,
    ) -> str:
        """
        Classify a list block based on context.

        Returns:
            "params" | "response" | "description"
        """
        # Check preceding block for context
        if index > 0:
            prev_content = blocks[index - 1].content.lower()

            if self._response_pattern.search(prev_content):
                return "response"
            if self._params_pattern.search(prev_content):
                return "params"

        return "description"

    def _is_endpoint_specific_description(
        self,
        block: StructureBlock,
        blocks: List[StructureBlock],
        index: int,
        current_section: APISection,
    ) -> bool:
        """
        Determine if a description is specific to an endpoint.

        Rules:
        - Short description immediately after endpoint -> specific
        - Description after params/response/examples -> shared
        """
        if not current_section.endpoints:
            return False

        # If we already have params/response/examples, description is shared
        if (
            current_section.shared_params_blocks
            or current_section.shared_response_blocks
            or current_section.shared_example_blocks
        ):
            return False

        # Check if this is immediately after an endpoint
        last_endpoint_idx = current_section.endpoints[-1].block_index

        # If within 2 blocks of endpoint and short, it's endpoint-specific
        if index - last_endpoint_idx <= 2:
            if len(block.content.strip()) < 200:
                return True

        return False

    def _log_detection_results(self, result: APIDocumentInfo) -> None:
        """Log API structure detection results."""
        logger.info(
            f"[Phase5.5] API structure detection: is_api_doc={result.is_api_doc}, "
            f"sections={len(result.api_sections)}, "
            f"multi_endpoint_sections={result.multi_endpoint_section_count}"
        )

        for i, section in enumerate(result.api_sections):
            endpoints_desc = ", ".join(
                [f"{ep.method} {ep.path}" for ep in section.endpoints]
            )
            logger.debug(
                f"[Phase5.5] Section[{i}]: heading={section.heading_block}, "
                f"endpoints=[{endpoints_desc}], "
                f"shared_params={section.shared_params_blocks}, "
                f"shared_response={section.shared_response_blocks}, "
                f"shared_examples={section.shared_example_blocks}"
            )

            if section.is_multi_endpoint:
                logger.info(
                    f"[Phase5.5] Multi-endpoint section detected: "
                    f"{len(section.endpoints)} endpoints "
                    f"sharing params={len(section.shared_params_blocks)}, "
                    f"response={len(section.shared_response_blocks)}, "
                    f"examples={len(section.shared_example_blocks)}"
                )
