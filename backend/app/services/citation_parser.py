# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Citation parser service for knowledge base references.

Parses AI response content to extract citation markers [N] and re-indexes
them to produce a clean, sequential citation numbering system.
"""

import re
from typing import Dict, List, Tuple

from app.schemas.knowledge import CandidateChunk, CitationSource


class CitationParser:
    """Parser for citation markers in AI responses.

    Handles:
    1. Extracting [N] markers from AI response text
    2. Filtering to only include actually cited sources
    3. Re-indexing to produce sequential [1], [2], [3]... numbering
    4. Building final source list with document/chunk location info
    """

    # Pattern to match citation markers like [1], [2], [12], etc.
    CITATION_PATTERN = re.compile(r"\[(\d+)\]")

    @classmethod
    def parse_citations(cls, content: str) -> List[int]:
        """Extract all citation indices from content.

        Args:
            content: AI response text containing [N] markers

        Returns:
            List of citation indices (1-based) in order of appearance
        """
        matches = cls.CITATION_PATTERN.findall(content)
        # Return unique indices in order of first appearance
        seen = set()
        result = []
        for match in matches:
            idx = int(match)
            if idx not in seen:
                seen.add(idx)
                result.append(idx)
        return result

    @classmethod
    def reindex_citations(
        cls,
        content: str,
        old_to_new_map: Dict[int, int],
    ) -> str:
        """Replace citation markers with re-indexed values.

        Args:
            content: Original AI response text
            old_to_new_map: Mapping from old retrieval_index to new sequential index

        Returns:
            Content with re-indexed citation markers
        """

        def replace_citation(match):
            old_idx = int(match.group(1))
            if old_idx in old_to_new_map:
                return f"[{old_to_new_map[old_idx]}]"
            return match.group(0)  # Keep original if not in map

        return cls.CITATION_PATTERN.sub(replace_citation, content)

    @classmethod
    def filter_and_reindex_sources(
        cls,
        content: str,
        candidates: List[CandidateChunk],
    ) -> Tuple[str, List[CitationSource]]:
        """Filter candidates to only those cited, re-index, and return sources.

        This is the main entry point for citation processing:
        1. Parse content to find which retrieval_index values were cited
        2. Build mapping from old to new sequential indices
        3. Re-index citations in content
        4. Build final source list

        Args:
            content: AI response text with [N] markers
            candidates: All candidate chunks from retrieval (with retrieval_index)

        Returns:
            Tuple of (processed_content, sources):
            - processed_content: Content with sequential [1], [2], [3]... markers
            - sources: List of CitationSource with precise document/chunk location
        """
        # Step 1: Extract cited indices
        cited_indices = cls.parse_citations(content)

        if not cited_indices:
            # No citations found, return original content and empty sources
            return content, []

        # Step 2: Build candidate lookup by retrieval_index
        candidate_map = {c.retrieval_index: c for c in candidates}

        # Step 3: Build old->new index mapping and filter to cited only
        old_to_new: Dict[int, int] = {}
        sources: List[CitationSource] = []
        new_index = 1

        for old_idx in cited_indices:
            if old_idx in candidate_map:
                old_to_new[old_idx] = new_index
                candidate = candidate_map[old_idx]
                sources.append(
                    CitationSource(
                        index=new_index,
                        kb_id=candidate.kb_id,
                        document_id=candidate.document_id,
                        document_name=candidate.document_name,
                        chunk_index=candidate.chunk_index,
                    )
                )
                new_index += 1

        # Step 4: Re-index content
        processed_content = cls.reindex_citations(content, old_to_new)

        return processed_content, sources

    @classmethod
    def build_citation_prompt(
        cls,
        candidates: List[CandidateChunk],
        base_prompt: str = "",
    ) -> str:
        """Build system prompt section with citation instructions.

        Creates a formatted reference section for the LLM to use when
        generating responses with citations.

        Args:
            candidates: Candidate chunks from retrieval
            base_prompt: Optional base prompt to prepend

        Returns:
            Complete prompt with reference materials and citation instructions
        """
        if not candidates:
            return base_prompt

        # Build reference section
        reference_lines = [
            "",
            "=== Reference Materials ===",
            "Use [N] to cite from the following reference materials when answering:",
            "",
        ]

        for candidate in candidates:
            reference_lines.append(
                f"[{candidate.retrieval_index}] Source: {candidate.document_name}"
            )
            reference_lines.append(f"Content: {candidate.content}")
            reference_lines.append("")

        reference_lines.extend(
            [
                "=== Citation Instructions ===",
                "- Only cite materials you actually use in your response",
                "- Use the number format [N] to reference sources",
                "- You may cite multiple sources for the same point",
                "- If no relevant information is found, say so clearly",
                "",
            ]
        )

        reference_section = "\n".join(reference_lines)

        if base_prompt:
            return f"{base_prompt}\n{reference_section}"
        return reference_section


# Export singleton instance for convenience
citation_parser = CitationParser()
