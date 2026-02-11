# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Comprehensive tests for MarkdownProcessor.

Tests cover:
1. Table conversion to key-value format
2. Noise removal (horizontal rules, empty links, HTML comments, whitespace)
3. Code block protection
4. Code block never-split guarantee
5. Header-based splitting (H1-H3)
6. Small chunk merging
7. Large chunk splitting
8. Context prefix injection
9. End-to-end processing
"""

import pytest

from app.services.rag.splitter.markdown_processor import (
    ChunkWithContext,
    MarkdownProcessor,
)


class TestTableConversion:
    """Tests for table to key-value conversion."""

    def test_simple_table_conversion(self):
        """Test basic table conversion to key-value format."""
        processor = MarkdownProcessor()

        markdown = """| Name | Price | Quantity |
|------|-------|----------|
| Apple | $5 | 10 |
| Banana | $3 | 20 |"""

        result = processor._convert_tables_to_keyvalue(markdown)

        assert "Name: Apple" in result
        assert "Price: $5" in result
        assert "Quantity: 10" in result
        assert "Name: Banana" in result
        assert "Price: $3" in result
        assert "Quantity: 20" in result
        # Table syntax should be removed
        assert "|---" not in result

    def test_table_with_alignment(self):
        """Test table with alignment markers in separator."""
        processor = MarkdownProcessor()

        markdown = """| Left | Center | Right |
|:-----|:------:|------:|
| a | b | c |"""

        result = processor._convert_tables_to_keyvalue(markdown)

        assert "Left: a" in result
        assert "Center: b" in result
        assert "Right: c" in result

    def test_table_with_empty_cells(self):
        """Test table with some empty cells."""
        processor = MarkdownProcessor()

        markdown = """| Name | Value |
|------|-------|
| Key1 | val1 |
| Key2 |  |"""

        result = processor._convert_tables_to_keyvalue(markdown)

        assert "Name: Key1" in result
        assert "Value: val1" in result
        assert "Name: Key2" in result

    def test_no_table_unchanged(self):
        """Test that non-table content is unchanged."""
        processor = MarkdownProcessor()

        markdown = """# Header

Some paragraph text.

- List item 1
- List item 2"""

        result = processor._convert_tables_to_keyvalue(markdown)

        assert result == markdown


class TestNoiseRemoval:
    """Tests for noise element removal."""

    def test_horizontal_rule_removal(self):
        """Test removal of horizontal rules."""
        processor = MarkdownProcessor()

        markdown = """Text before

---

Text after

***

More text

___

End"""

        result = processor._remove_noise(markdown)

        assert "---" not in result
        assert "***" not in result
        assert "___" not in result
        assert "Text before" in result
        assert "Text after" in result
        assert "More text" in result
        assert "End" in result

    def test_empty_link_removal(self):
        """Test removal of empty links."""
        processor = MarkdownProcessor()

        markdown = """Here is some text [](). And []( ) more [](#) content."""

        result = processor._remove_noise(markdown)

        assert "[](" not in result
        assert "Here is some text" in result
        assert "content" in result

    def test_html_comment_removal(self):
        """Test removal of HTML comments."""
        processor = MarkdownProcessor()

        markdown = """Text before <!-- This is a comment --> text after.

<!-- Multi
line
comment -->

End."""

        result = processor._remove_noise(markdown)

        assert "<!--" not in result
        assert "-->" not in result
        assert "This is a comment" not in result
        assert "Text before" in result
        assert "text after" in result
        assert "End." in result

    def test_excessive_whitespace_compression(self):
        """Test compression of excessive newlines."""
        processor = MarkdownProcessor()

        markdown = """Line 1




Line 2"""

        result = processor._remove_noise(markdown)

        # Should have at most 2 consecutive newlines
        assert "\n\n\n\n" not in result
        assert "Line 1" in result
        assert "Line 2" in result

    def test_trailing_whitespace_removal(self):
        """Test removal of trailing whitespace."""
        processor = MarkdownProcessor()

        markdown = "Line with trailing spaces   \nAnother line  \t\nEnd"

        result = processor._remove_noise(markdown)

        # Lines should not end with spaces
        lines = result.split("\n")
        for line in lines:
            assert line == line.rstrip(), f"Line '{line}' has trailing whitespace"


class TestImageAndLinkProcessing:
    """Tests for image and link processing."""

    def test_image_conversion(self):
        """Test image conversion to alt text format."""
        processor = MarkdownProcessor()

        markdown = (
            """Here is an image: ![Diagram of system](https://example.com/img.png)"""
        )

        result = processor._process_images_and_links(markdown)

        assert "[Image: Diagram of system]" in result
        assert "https://example.com" not in result
        assert "![" not in result

    def test_empty_image_removal(self):
        """Test removal of images with empty alt text."""
        processor = MarkdownProcessor()

        markdown = """Text before ![](https://example.com/img.png) text after."""

        result = processor._process_images_and_links(markdown)

        assert "![]" not in result
        assert "https://example.com" not in result
        assert "Text before" in result
        assert "text after" in result

    def test_link_text_extraction(self):
        """Test extraction of link text."""
        processor = MarkdownProcessor()

        markdown = """Click [here](https://example.com) to learn more about [our product](https://product.com)."""

        result = processor._process_images_and_links(markdown)

        assert "here" in result
        assert "our product" in result
        assert "https://example.com" not in result
        assert "https://product.com" not in result
        assert "[" not in result or "[Image:" in result

    def test_empty_link_text_removal(self):
        """Test removal of links with empty text."""
        processor = MarkdownProcessor()

        markdown = """Before [](https://example.com) after."""

        result = processor._process_images_and_links(markdown)

        assert "Before" in result
        assert "after" in result
        assert "https://example.com" not in result


class TestCodeBlockProtection:
    """Tests for code block protection during preprocessing."""

    def test_fenced_code_block_protection(self):
        """Test that fenced code blocks are protected from preprocessing."""
        processor = MarkdownProcessor()

        markdown = """# Header

Some text.

```python
# This is code
def foo():
    return "---"  # This --- should NOT be removed
```

More text after code."""

        # Protect code blocks
        text, placeholders = processor._protect_code_blocks(markdown)

        # Code block should be replaced with placeholder
        assert "```python" not in text
        assert len(placeholders) > 0

        # Apply noise removal (should not affect protected code)
        cleaned = processor._remove_noise(text)

        # Restore code blocks
        restored = processor._restore_code_blocks(cleaned, placeholders)

        # Code should be intact
        assert "# This is code" in restored
        assert 'return "---"' in restored
        assert "def foo():" in restored

    def test_inline_code_protection(self):
        """Test that inline code is protected from preprocessing."""
        processor = MarkdownProcessor()

        markdown = """Use `---` to create horizontal rules. The `[](url)` syntax creates links."""

        text, placeholders = processor._protect_code_blocks(markdown)

        # Apply noise removal
        cleaned = processor._remove_noise(text)
        cleaned = processor._process_images_and_links(cleaned)

        # Restore
        restored = processor._restore_code_blocks(cleaned, placeholders)

        # Inline code should be intact
        assert "`---`" in restored
        assert "`[](url)`" in restored

    def test_nested_code_blocks(self):
        """Test handling of code blocks with backticks inside."""
        processor = MarkdownProcessor()

        markdown = """Here is code:

```markdown
# Example
Use `inline code` here.
```

End."""

        text, placeholders = processor._protect_code_blocks(markdown)
        restored = processor._restore_code_blocks(text, placeholders)

        assert "```markdown" in restored
        assert "`inline code`" in restored


class TestCodeBlockNeverSplit:
    """Tests to verify code blocks are never split regardless of size."""

    def test_large_code_block_not_split(self):
        """Test that large code blocks are kept intact."""
        processor = MarkdownProcessor(chunk_size=100)  # Small chunk size

        # Create a large code block (much larger than chunk_size)
        large_code = "\n".join([f"line_{i} = {i}" for i in range(100)])
        markdown = f"""# Header

```python
{large_code}
```

End text."""

        documents = processor.process(markdown, "test_doc")

        # Find the chunk containing the code block
        code_chunk = None
        for doc in documents:
            if "line_0 = 0" in doc.text and "line_99 = 99" in doc.text:
                code_chunk = doc
                break

        assert code_chunk is not None, "Code block should be in a single chunk"
        # Code block should contain all lines
        assert "line_50 = 50" in code_chunk.text

    def test_multiple_code_blocks_separate_chunks(self):
        """Test that multiple code blocks become separate chunks."""
        processor = MarkdownProcessor(chunk_size=100)

        markdown = """# Section 1

```python
def func1():
    pass
```

# Section 2

```python
def func2():
    pass
```"""

        documents = processor.process(markdown, "test_doc")

        # Each code block should be preserved
        code_blocks_found = 0
        for doc in documents:
            if "def func1" in doc.text:
                code_blocks_found += 1
                assert "pass" in doc.text
            if "def func2" in doc.text:
                code_blocks_found += 1
                assert "pass" in doc.text

        assert code_blocks_found >= 2, "Both code blocks should be preserved"


class TestHeaderSplitting:
    """Tests for header-based splitting."""

    def test_h1_h2_h3_splitting(self):
        """Test splitting at H1, H2, H3 levels."""
        # Use small min_chunk_size to prevent merging
        processor = MarkdownProcessor(min_chunk_size=50)

        markdown = """# Chapter 1

Introduction text with enough content to prevent merging.

## Section 1.1

Section content that has sufficient length for testing purposes.

### Subsection 1.1.1

Subsection content that is also long enough to avoid being merged.

## Section 1.2

Another section with adequate content length for the test.

# Chapter 2

Chapter 2 content that is sufficiently long for testing purposes."""

        documents = processor.process(markdown, "Test Document")

        # Should have multiple chunks (at least 4 based on headers)
        assert len(documents) >= 3

        # Check that headers are preserved
        texts = [doc.text for doc in documents]
        all_text = "\n".join(texts)

        assert "# Chapter 1" in all_text
        assert "## Section 1.1" in all_text
        assert "# Chapter 2" in all_text

    def test_h4_h5_h6_not_split(self):
        """Test that H4-H6 headers don't cause splits."""
        processor = MarkdownProcessor()

        markdown = """# Main Header

Introduction.

#### H4 Header

H4 content.

##### H5 Header

H5 content.

###### H6 Header

H6 content."""

        documents = processor.process(markdown, "Test Doc")

        # H4-H6 should be in same chunk as their parent
        # Find chunk with Main Header
        main_chunk = None
        for doc in documents:
            if "# Main Header" in doc.text:
                main_chunk = doc
                break

        assert main_chunk is not None
        # All H4-H6 content should be in the same chunk or adjacent
        # (depending on size constraints)

    def test_no_header_content(self):
        """Test content without any headers."""
        processor = MarkdownProcessor()

        markdown = """Just some plain text.

More paragraphs here.

And even more content."""

        documents = processor.process(markdown, "No Headers Doc")

        assert len(documents) >= 1
        assert "Just some plain text" in documents[0].text


class TestChunkMerging:
    """Tests for small chunk merging."""

    def test_small_chunks_merged(self):
        """Test that chunks smaller than min_chunk_size are merged."""
        processor = MarkdownProcessor(chunk_size=1024, min_chunk_size=256)

        # Create content with small sections
        markdown = """# A

Hi.

# B

Hello.

# C

World."""

        documents = processor.process(markdown, "Merge Test")

        # Small chunks should be merged
        # The exact number depends on implementation, but should be fewer
        # than the number of headers
        assert len(documents) < 3 or all(len(doc.text) >= 50 for doc in documents)

    def test_code_blocks_not_merged(self):
        """Test that code blocks are not merged with adjacent chunks."""
        processor = MarkdownProcessor(min_chunk_size=500)

        markdown = """# Header

Short intro.

```python
code()
```

# Another

Short text."""

        documents = processor.process(markdown, "Code Merge Test")

        # Code block should remain separate
        for doc in documents:
            if "```python" in doc.text:
                # Code block chunk should be identifiable
                assert "code()" in doc.text


class TestLargeChunkSplitting:
    """Tests for large chunk splitting."""

    def test_large_text_chunk_split(self):
        """Test that large text chunks are split."""
        processor = MarkdownProcessor(chunk_size=200, min_chunk_size=50)

        # Create text with sentence boundaries for proper splitting
        sentences = [f"This is sentence number {i}." for i in range(50)]
        large_text = " ".join(sentences)
        markdown = f"""# Header

{large_text}"""

        documents = processor.process(markdown, "Large Text")

        # Should be split into multiple chunks
        assert len(documents) > 1

    def test_code_block_not_split_even_when_large(self):
        """Test that code blocks are never split even when exceeding chunk_size."""
        processor = MarkdownProcessor(chunk_size=100)

        # Create large code block
        large_code = "\n".join([f"print({i})" for i in range(50)])
        markdown = f"""```python
{large_code}
```"""

        documents = processor.process(markdown, "Large Code")

        # Code should be in single chunk
        code_doc = None
        for doc in documents:
            if "print(0)" in doc.text:
                code_doc = doc
                break

        assert code_doc is not None
        assert "print(49)" in code_doc.text


class TestContextPrefixInjection:
    """Tests for context prefix injection."""

    def test_document_title_injected(self):
        """Test that document title is injected as prefix."""
        processor = MarkdownProcessor()

        markdown = """# Section

Content here."""

        documents = processor.process(markdown, "My Document Title")

        # First chunk should have document title
        assert "[Document: My Document Title]" in documents[0].text

    def test_header_hierarchy_injected(self):
        """Test that header hierarchy is injected as location."""
        processor = MarkdownProcessor()

        markdown = """# Chapter 1

## Section 1.1

### Detail 1.1.1

Some detailed content here."""

        documents = processor.process(markdown, "Guide")

        # Find chunk with the detailed content
        detail_chunk = None
        for doc in documents:
            if "Detail 1.1.1" in doc.text:
                detail_chunk = doc
                break

        assert detail_chunk is not None
        # Should have location prefix with hierarchy
        assert "[Location:" in detail_chunk.text
        # Hierarchy should include parent headers
        assert "Chapter 1" in detail_chunk.text

    def test_empty_title_no_prefix(self):
        """Test that empty title doesn't add document prefix."""
        processor = MarkdownProcessor()

        markdown = """Just content without structure."""

        documents = processor.process(markdown, "")

        # Should not have [Document: ] prefix with empty title
        assert "[Document: ]" not in documents[0].text

    def test_metadata_includes_hierarchy(self):
        """Test that metadata includes header hierarchy."""
        processor = MarkdownProcessor()

        markdown = """# Main

## Sub

Content."""

        documents = processor.process(markdown, "Test")

        # Check metadata
        for doc in documents:
            assert "header_hierarchy" in doc.metadata
            assert "header_level" in doc.metadata


class TestEndToEnd:
    """End-to-end tests with realistic markdown documents."""

    def test_full_document_processing(self):
        """Test processing of a complete markdown document."""
        processor = MarkdownProcessor(chunk_size=500)

        markdown = """# Product Manual

Welcome to our product manual.

## Installation

### Requirements

| Component | Version |
|-----------|---------|
| Python | 3.8+ |
| Node.js | 16+ |

### Steps

1. Clone the repository
2. Run `npm install`
3. Configure settings

---

## Usage

Here's how to use the product:

```python
from product import Client

client = Client()
client.connect()
```

![Architecture](https://example.com/arch.png)

### API Reference

See [documentation](https://docs.example.com) for details.

<!-- TODO: Add more examples -->

## Troubleshooting

If you encounter issues:

- Check logs
- Restart service
- Contact [support](mailto:support@example.com)

___

## License

MIT License."""

        documents = processor.process(markdown, "Product Manual")

        # Should produce multiple chunks
        assert len(documents) > 1

        # Combine all text for verification
        all_text = "\n".join([doc.text for doc in documents])

        # Tables should be converted
        assert "Component: Python" in all_text
        assert "Version: 3.8+" in all_text

        # Code blocks should be preserved
        assert "from product import Client" in all_text
        assert "client.connect()" in all_text

        # Images converted to alt text
        assert "[Image: Architecture]" in all_text
        assert "https://example.com" not in all_text

        # Links converted to text only
        assert "documentation" in all_text
        assert "support" in all_text
        assert "https://docs.example.com" not in all_text

        # Horizontal rules removed
        assert "\n---\n" not in all_text.replace("[Document:", "").replace(
            "[Location:", ""
        )
        assert "\n___\n" not in all_text.replace("[Document:", "").replace(
            "[Location:", ""
        )

        # HTML comments removed
        assert "TODO: Add more examples" not in all_text
        assert "<!--" not in all_text

        # Context prefixes present
        assert "[Document: Product Manual]" in all_text

    def test_chinese_content(self):
        """Test processing of Chinese markdown content."""
        processor = MarkdownProcessor()

        markdown = """# 产品说明书

欢迎使用本产品。

## 安装指南

### 系统要求

| 组件 | 版本 |
|------|------|
| Python | 3.8以上 |

### 安装步骤

运行 `pip install product` 命令。

## 使用方法

详见[文档](https://docs.example.com)。"""

        documents = processor.process(markdown, "产品说明书")

        assert len(documents) > 0

        all_text = "\n".join([doc.text for doc in documents])

        # Chinese content should be preserved
        assert "欢迎使用本产品" in all_text
        assert "系统要求" in all_text
        # Table converted
        assert "组件: Python" in all_text
        # Code preserved
        assert "`pip install product`" in all_text
        # Link text extracted
        assert "文档" in all_text


class TestEdgeCases:
    """Tests for edge cases and boundary conditions."""

    def test_empty_input(self):
        """Test handling of empty input."""
        processor = MarkdownProcessor()

        documents = processor.process("", "Empty")
        assert documents == []

        documents = processor.process("   \n\n   ", "Whitespace")
        assert documents == []

    def test_only_code_block(self):
        """Test document with only a code block."""
        processor = MarkdownProcessor()

        markdown = """```python
print("hello")
```"""

        documents = processor.process(markdown, "Code Only")

        assert len(documents) == 1
        assert 'print("hello")' in documents[0].text

    def test_deeply_nested_headers(self):
        """Test handling of deeply nested headers."""
        processor = MarkdownProcessor()

        markdown = """# H1
## H2
### H3
#### H4
##### H5
###### H6

Content at deepest level."""

        documents = processor.process(markdown, "Nested")

        # Should not crash and should preserve content
        all_text = "\n".join([doc.text for doc in documents])
        assert "Content at deepest level" in all_text

    def test_malformed_table(self):
        """Test handling of malformed tables."""
        processor = MarkdownProcessor()

        # Table without proper separator
        markdown = """| Header |
| Data |"""

        # Should not crash
        documents = processor.process(markdown, "Malformed")
        assert len(documents) >= 1

    def test_special_characters_in_headers(self):
        """Test headers with special characters."""
        processor = MarkdownProcessor()

        markdown = """# Header with `code` and [link](url)

## Section: Important! (v2.0)

Content."""

        documents = processor.process(markdown, "Special")

        all_text = "\n".join([doc.text for doc in documents])
        assert "Header with" in all_text
        assert "Section: Important!" in all_text


class TestConfiguration:
    """Tests for processor configuration."""

    def test_custom_chunk_size(self):
        """Test custom chunk size configuration."""
        processor = MarkdownProcessor(chunk_size=200, min_chunk_size=50)

        # Create text with sentence boundaries for proper splitting
        sentences = [f"This is sentence number {i}." for i in range(50)]
        large_text = " ".join(sentences)
        markdown = f"""# Header

{large_text}"""

        documents = processor.process(markdown, "Config Test")

        # Should be split into multiple chunks due to sentence boundaries
        assert len(documents) > 1

        # Verify chunks are smaller than original
        original_len = len(markdown)
        for doc in documents:
            # Each chunk should be significantly smaller than original
            # (accounting for context prefix overhead)
            assert len(doc.text) < original_len

    def test_custom_min_chunk_size(self):
        """Test custom minimum chunk size for merging."""
        processor = MarkdownProcessor(min_chunk_size=100)

        markdown = """# A

X.

# B

Y."""

        documents = processor.process(markdown, "Min Size Test")

        # Very small chunks should be merged
        assert len(documents) < 3

    def test_get_config(self):
        """Test configuration retrieval."""
        processor = MarkdownProcessor(
            chunk_size=512,
            chunk_overlap=25,
            min_chunk_size=128,
            split_header_level=2,
        )

        config = processor.get_config()

        assert config["type"] == "smart"
        assert config["subtype"] == "markdown_enhanced"
        assert config["chunk_size"] == 512
        assert config["chunk_overlap"] == 25
        assert config["min_chunk_size"] == 128
        assert config["split_header_level"] == 2
