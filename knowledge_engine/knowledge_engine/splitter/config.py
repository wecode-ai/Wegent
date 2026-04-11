# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class SplitterConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SemanticSplitterConfig(SplitterConfigModel):
    type: Literal["semantic"] = "semantic"
    buffer_size: int = Field(1, ge=1, le=10)
    breakpoint_percentile_threshold: int = Field(95, ge=50, le=100)


class SentenceSplitterConfig(SplitterConfigModel):
    type: Literal["sentence"] = "sentence"
    chunk_size: int = Field(1024, ge=128, le=8192)
    chunk_overlap: int = Field(200, ge=0, le=2048)
    separator: str = "\n\n"

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info) -> int:
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


class SmartSplitterConfig(SplitterConfigModel):
    type: Literal["smart"] = "smart"
    chunk_size: int = Field(1024, ge=128, le=8192)
    chunk_overlap: int = Field(50, ge=0, le=2048)
    file_extension: Optional[str] = None
    subtype: Optional[str] = None

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info) -> int:
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


class FlatChunkConfig(SplitterConfigModel):
    chunk_size: int = Field(1024, ge=128, le=8192)
    chunk_overlap: int = Field(200, ge=0, le=2048)
    separator: str = "\n\n"

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, value: int, info) -> int:
        chunk_size = info.data.get("chunk_size", 1024)
        if value >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({value}) must be less than chunk_size ({chunk_size})"
            )
        return value


class HierarchicalChunkConfig(SplitterConfigModel):
    parent_chunk_size: int = Field(2048, ge=256, le=16384)
    child_chunk_size: int = Field(512, ge=128, le=8192)
    child_chunk_overlap: int = Field(64, ge=0, le=2048)

    @field_validator("child_chunk_overlap")
    @classmethod
    def validate_child_overlap(cls, value: int, info) -> int:
        child_chunk_size = info.data.get("child_chunk_size", 512)
        if value >= child_chunk_size:
            raise ValueError(
                "child_chunk_overlap "
                f"({value}) must be less than child_chunk_size ({child_chunk_size})"
            )
        return value

    @model_validator(mode="after")
    def validate_child_size(self) -> "HierarchicalChunkConfig":
        if self.child_chunk_size >= self.parent_chunk_size:
            raise ValueError(
                "child_chunk_size "
                f"({self.child_chunk_size}) must be less than parent_chunk_size ({self.parent_chunk_size})"
            )
        return self


class MarkdownEnhancementConfig(SplitterConfigModel):
    enabled: bool = False


class NormalizedSplitterConfig(SplitterConfigModel):
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
        if self.chunk_strategy == "flat":
            if self.flat_config is None:
                self.flat_config = FlatChunkConfig()
            self.hierarchical_config = None
        elif self.chunk_strategy == "hierarchical":
            if self.hierarchical_config is None:
                self.hierarchical_config = HierarchicalChunkConfig()
            self.flat_config = None
        elif self.chunk_strategy == "semantic":
            if self.semantic_config is None:
                self.semantic_config = SemanticSplitterConfig()
            self.flat_config = None
            self.hierarchical_config = None
        return self


LegacySplitterConfig = (
    SemanticSplitterConfig | SentenceSplitterConfig | SmartSplitterConfig
)
SplitterConfig = NormalizedSplitterConfig


def normalize_splitter_config(
    config: dict | SplitterConfigModel | None,
) -> NormalizedSplitterConfig:
    if config is None or config == {}:
        return NormalizedSplitterConfig(
            chunk_strategy="flat",
            format_enhancement="none",
            flat_config=FlatChunkConfig(),
        )

    if isinstance(config, NormalizedSplitterConfig):
        return config

    if isinstance(config, SplitterConfigModel):
        config = config.model_dump(exclude_none=True)

    splitter_type = config.get("type")
    if splitter_type == "smart":
        return NormalizedSplitterConfig(
            chunk_strategy="flat",
            format_enhancement="file_aware",
            flat_config=FlatChunkConfig(
                chunk_size=config.get("chunk_size", 1024),
                chunk_overlap=config.get("chunk_overlap", 50),
                separator=config.get("separator", "\n\n"),
            ),
            markdown_enhancement=MarkdownEnhancementConfig(enabled=True),
            legacy_type="smart",
        )

    if splitter_type == "sentence":
        return NormalizedSplitterConfig(
            chunk_strategy="flat",
            format_enhancement="none",
            flat_config=FlatChunkConfig(
                chunk_size=config.get("chunk_size", 1024),
                chunk_overlap=config.get("chunk_overlap", 200),
                separator=config.get("separator", "\n\n"),
            ),
            markdown_enhancement=MarkdownEnhancementConfig(enabled=False),
            legacy_type="sentence",
        )

    if splitter_type == "semantic":
        return NormalizedSplitterConfig(
            chunk_strategy="semantic",
            format_enhancement="none",
            semantic_config=SemanticSplitterConfig(
                buffer_size=config.get("buffer_size", 1),
                breakpoint_percentile_threshold=config.get(
                    "breakpoint_percentile_threshold", 95
                ),
            ),
            markdown_enhancement=MarkdownEnhancementConfig(enabled=False),
            legacy_type="semantic",
        )

    return NormalizedSplitterConfig.model_validate(config)


def serialize_splitter_config(config: NormalizedSplitterConfig) -> dict:
    return config.model_dump(exclude_none=True)


def parse_splitter_config(
    config: dict | SplitterConfigModel | None,
) -> NormalizedSplitterConfig | None:
    if config is None:
        return None

    return normalize_splitter_config(config)
