# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class SplitterConfigModel(BaseModel):
    """Base model for splitter configuration payloads."""

    model_config = ConfigDict(extra="forbid")


class SemanticSplitterConfig(SplitterConfigModel):
    """Legacy semantic splitter configuration."""

    type: Literal["semantic"] = "semantic"
    buffer_size: int = Field(
        1, ge=1, le=10, description="Buffer size for semantic splitter"
    )
    breakpoint_percentile_threshold: int = Field(
        95,
        ge=50,
        le=100,
        description="Percentile threshold for determining breakpoints",
    )


class SentenceSplitterConfig(SplitterConfigModel):
    """Legacy sentence splitter configuration."""

    type: Literal["sentence"] = "sentence"
    chunk_size: int = Field(
        1024, ge=128, le=8192, description="Maximum chunk size in characters"
    )
    chunk_overlap: int = Field(
        200,
        ge=0,
        le=2048,
        description="Number of characters to overlap between chunks",
    )
    separator: str = Field(
        "\n\n",
        description="Separator for splitting. Common options: '\\n\\n' (paragraph, default), '\\n' (newline), ' ' (space), '.' (sentence)",
    )

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info):
        """Validate that chunk_overlap is less than chunk_size."""
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


class SmartSplitterConfig(SplitterConfigModel):
    """Legacy smart splitter configuration."""

    type: Literal["smart"] = "smart"
    chunk_size: int = Field(
        1024, ge=128, le=8192, description="Maximum chunk size in characters"
    )
    chunk_overlap: int = Field(
        50,
        ge=0,
        le=2048,
        description="Number of characters to overlap between chunks",
    )
    file_extension: str | None = Field(
        None,
        description="File extension to determine splitting strategy (.md, .txt, .pdf, .doc, .docx)",
    )
    subtype: str | None = Field(
        None,
        description="Splitting strategy subtype (markdown_sentence, sentence, recursive_character)",
    )

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info):
        """Validate that chunk_overlap is less than chunk_size."""
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


class FlatChunkConfig(SplitterConfigModel):
    """Configuration for flat chunking."""

    chunk_size: int = Field(
        1024, ge=128, le=8192, description="Maximum chunk size in characters"
    )
    chunk_overlap: int = Field(
        200,
        ge=0,
        le=2048,
        description="Number of characters to overlap between chunks",
    )
    separator: str = Field(
        "\n\n",
        description="Separator for splitting. Common options: '\\n\\n' (paragraph, default), '\\n' (newline), ' ' (space), '.' (sentence)",
    )

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info):
        """Validate that chunk_overlap is less than chunk_size."""
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


class HierarchicalChunkConfig(SplitterConfigModel):
    """Configuration for parent-child chunking."""

    parent_chunk_size: int = Field(
        2048, ge=256, le=16384, description="Parent chunk size in characters"
    )
    child_chunk_size: int = Field(
        512, ge=128, le=8192, description="Child chunk size in characters"
    )
    child_chunk_overlap: int = Field(
        64,
        ge=0,
        le=2048,
        description="Number of characters to overlap between child chunks",
    )
    parent_separator: str = Field(
        "\n\n",
        description="Separator used when splitting parent chunks",
    )
    child_separator: str = Field(
        "\n",
        description="Separator used when splitting child chunks",
    )

    @field_validator("child_chunk_overlap")
    @classmethod
    def validate_child_overlap(cls, value: int, info):
        """Validate that child_chunk_overlap is less than child_chunk_size."""
        child_chunk_size = info.data.get("child_chunk_size", 512)
        if value >= child_chunk_size:
            raise ValueError(
                "child_chunk_overlap "
                f"({value}) must be less than child_chunk_size ({child_chunk_size})"
            )
        return value

    @model_validator(mode="after")
    def validate_child_size(self) -> "HierarchicalChunkConfig":
        """Validate that child_chunk_size is strictly smaller than parent_chunk_size."""
        if self.child_chunk_size >= self.parent_chunk_size:
            raise ValueError(
                "child_chunk_size "
                f"({self.child_chunk_size}) must be less than parent_chunk_size ({self.parent_chunk_size})"
            )
        return self


class MarkdownEnhancementConfig(SplitterConfigModel):
    """Markdown title enhancement settings."""

    enabled: bool = False


class NormalizedSplitterConfig(SplitterConfigModel):
    """Normalized splitter configuration shared by backend and runtime."""

    chunk_strategy: Literal["flat", "hierarchical", "semantic"]
    format_enhancement: Literal["none", "file_aware"] = "none"
    flat_config: FlatChunkConfig | None = None
    hierarchical_config: HierarchicalChunkConfig | None = None
    semantic_config: SemanticSplitterConfig | None = None
    markdown_enhancement: MarkdownEnhancementConfig = Field(
        default_factory=MarkdownEnhancementConfig
    )
    legacy_type: Literal["sentence", "smart", "semantic"] | None = None

    @model_validator(mode="after")
    def validate_strategy_config(self) -> "NormalizedSplitterConfig":
        """Ensure the config block matches the selected chunk strategy."""
        if self.chunk_strategy == "flat":
            if self.flat_config is None:
                self.flat_config = FlatChunkConfig()
            self.semantic_config = None
            self.hierarchical_config = None
        elif self.chunk_strategy == "hierarchical":
            if self.hierarchical_config is None:
                self.hierarchical_config = HierarchicalChunkConfig()
            self.flat_config = None
            self.semantic_config = None
        elif self.chunk_strategy == "semantic":
            if self.semantic_config is None:
                self.semantic_config = SemanticSplitterConfig()
            self.flat_config = None
            self.hierarchical_config = None
        return self


LegacySplitterConfig = (
    SemanticSplitterConfig | SentenceSplitterConfig | SmartSplitterConfig
)
SplitterConfig = Annotated[
    Union[
        NormalizedSplitterConfig,
        SemanticSplitterConfig,
        SentenceSplitterConfig,
        SmartSplitterConfig,
    ],
    Field(union_mode="left_to_right"),
]


def build_runtime_default_splitter_config() -> NormalizedSplitterConfig:
    """Build the runtime default used when a document has no splitter config."""
    return NormalizedSplitterConfig(
        chunk_strategy="flat",
        format_enhancement="file_aware",
        flat_config=FlatChunkConfig(
            chunk_size=1024,
            chunk_overlap=50,
            separator="\n\n",
        ),
        markdown_enhancement=MarkdownEnhancementConfig(enabled=True),
    )


def normalize_splitter_config(
    raw: dict | SplitterConfigModel | None,
) -> NormalizedSplitterConfig:
    """Convert legacy and normalized splitter payloads to one stable shape."""
    if raw is None or raw == {}:
        return NormalizedSplitterConfig(
            chunk_strategy="flat",
            format_enhancement="none",
            flat_config=FlatChunkConfig(),
        )

    if isinstance(raw, NormalizedSplitterConfig):
        return raw

    if isinstance(raw, SplitterConfigModel):
        raw = raw.model_dump(exclude_none=True)

    splitter_type = raw.get("type")
    if splitter_type == "smart":
        return NormalizedSplitterConfig(
            chunk_strategy="flat",
            format_enhancement="file_aware",
            flat_config=FlatChunkConfig(
                chunk_size=raw.get("chunk_size", 1024),
                chunk_overlap=raw.get("chunk_overlap", 50),
                separator=raw.get("separator", "\n\n"),
            ),
            markdown_enhancement=MarkdownEnhancementConfig(enabled=True),
            legacy_type="smart",
        )

    if splitter_type == "sentence":
        return NormalizedSplitterConfig(
            chunk_strategy="flat",
            format_enhancement="none",
            flat_config=FlatChunkConfig(
                chunk_size=raw.get("chunk_size", 1024),
                chunk_overlap=raw.get("chunk_overlap", 200),
                separator=raw.get("separator", "\n\n"),
            ),
            markdown_enhancement=MarkdownEnhancementConfig(enabled=False),
            legacy_type="sentence",
        )

    if splitter_type == "semantic":
        return NormalizedSplitterConfig(
            chunk_strategy="semantic",
            format_enhancement="none",
            semantic_config=SemanticSplitterConfig(
                buffer_size=raw.get("buffer_size", 1),
                breakpoint_percentile_threshold=raw.get(
                    "breakpoint_percentile_threshold", 95
                ),
            ),
            markdown_enhancement=MarkdownEnhancementConfig(enabled=False),
            legacy_type="semantic",
        )

    return NormalizedSplitterConfig.model_validate(raw)


def normalize_runtime_splitter_config(
    raw: dict | SplitterConfigModel | None,
) -> NormalizedSplitterConfig:
    """Normalize runtime splitter config, applying the runtime default for empty input."""
    if raw is None or raw == {}:
        return build_runtime_default_splitter_config()
    return normalize_splitter_config(raw)


def serialize_splitter_config(config: NormalizedSplitterConfig) -> dict:
    """Serialize normalized splitter config for transport and persistence."""
    return config.model_dump(exclude_none=True)
