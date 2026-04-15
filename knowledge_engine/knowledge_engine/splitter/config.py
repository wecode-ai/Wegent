from shared.models.splitter_config import (  # noqa: F401
    FlatChunkConfig,
    HierarchicalChunkConfig,
    MarkdownEnhancementConfig,
    NormalizedSplitterConfig,
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SmartSplitterConfig,
    SplitterConfig,
    SplitterConfigModel,
    build_runtime_default_splitter_config,
    normalize_runtime_splitter_config,
    normalize_splitter_config,
    serialize_splitter_config,
)


def parse_splitter_config(
    config: dict | SplitterConfigModel | None,
) -> NormalizedSplitterConfig | None:
    if config is None:
        return None

    return normalize_splitter_config(config)
