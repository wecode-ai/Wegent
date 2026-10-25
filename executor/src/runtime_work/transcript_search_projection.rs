// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{ops::Range, sync::Arc};

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

/// All public positions use UTF-16, matching JavaScript strings and DOM Range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SearchSourceSpan {
    pub item_id: String,
    pub start: usize,
    pub end: usize,
    pub source_start: usize,
    pub source_end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct SearchRegion {
    pub id: String,
    pub text: String,
    pub sources: Vec<SearchSourceSpan>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct SearchRange {
    pub start: usize,
    pub end: usize,
}

/// Annotations inside Markdown literals are visible text, not renderer directives.
pub(super) fn markdown_literal_ranges(source: &str) -> Vec<Range<usize>> {
    let parser = Parser::new_ext(source, markdown_options());
    let mut ranges: Vec<_> = parser
        .reference_definitions()
        .iter()
        .map(|(_, definition)| definition.span.clone())
        .collect();
    for (event, range) in parser.into_offset_iter() {
        if matches!(
            event,
            Event::Start(Tag::CodeBlock(_) | Tag::HtmlBlock | Tag::Link { .. } | Tag::Image { .. })
                | Event::Code(_)
                | Event::Html(_)
                | Event::InlineHtml(_)
        ) {
            ranges.push(range);
        }
    }
    ranges.sort_by_key(|range| range.start);
    ranges
}

fn markdown_options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

#[derive(Clone)]
struct Origin {
    item_id: Arc<str>,
    start: usize,
    end: usize,
}

/// A source character retains its raw item coordinates through normalization.
#[derive(Clone, Default)]
pub(super) struct MappedSource {
    text: String,
    // Byte-indexed origins make parser event offsets direct lookups.
    origins: Vec<Option<Origin>>,
}

impl MappedSource {
    pub fn new(item_id: &str, text: &str) -> Self {
        let mut result = Self::default();
        let mut offset = 0;
        let item_id: Arc<str> = Arc::from(item_id);
        for character in text.chars() {
            let end = offset + character.len_utf16();
            result.text.push(character);
            result.origins.extend(
                std::iter::repeat(Some(Origin {
                    item_id: item_id.clone(),
                    start: offset,
                    end,
                }))
                .take(character.len_utf8()),
            );
            offset = end;
        }
        result
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn append(&mut self, other: Self, separator: &str) {
        self.text.push_str(separator);
        self.origins
            .extend(std::iter::repeat(None).take(separator.len()));
        self.text.push_str(&other.text);
        self.origins.extend(other.origins);
    }

    pub fn remove(&mut self, ranges: impl IntoIterator<Item = Range<usize>>) {
        let mut ranges: Vec<_> = ranges.into_iter().collect();
        ranges.sort_by_key(|range| range.start);
        for range in ranges.into_iter().rev() {
            self.text.replace_range(range.clone(), "");
            self.origins.drain(range);
        }
    }

    pub fn trim(&mut self, end_only: bool) {
        let end = self.text.trim_end().len();
        let start = if end_only {
            0
        } else {
            self.text.len() - self.text.trim_start().len()
        };
        self.remove([end..self.text.len()]);
        if start > 0 {
            self.remove([0..start.min(end)]);
        }
    }

    pub fn projected_plain_region(self, id: &str, visible: &str) -> SearchRegion {
        let mut text = ProjectedText::default();
        text.push(visible, &self, 0..self.text.len());
        text.region(id)
    }

    pub fn reply_region(self, id: &str, visible: &str) -> SearchRegion {
        let answer = self.text.trim();
        let mut projected = ProjectedText {
            text: visible.to_owned(),
            sources: Vec::new(),
        };
        if !answer.is_empty() && visible.ends_with(answer) {
            let prefix = visible.len() - answer.len();
            let start = self.text.len() - self.text.trim_start().len();
            let mut mapped = ProjectedText::default();
            mapped.push(answer, &self, start..start + answer.len());
            let shift = visible[..prefix].encode_utf16().count();
            for mut span in mapped.sources {
                span.start += shift;
                span.end += shift;
                projected.sources.push(span);
            }
        }
        projected.region(id)
    }

    pub fn markdown_region(self, id: &str) -> SearchRegion {
        let mut frames = vec![TextFrame::new(None)];
        for (event, range) in Parser::new_ext(&self.text, markdown_options()).into_offset_iter() {
            match event {
                Event::Start(tag) => frames.push(TextFrame::new(Some(tag.to_end()))),
                Event::End(end) => {
                    let text = frames.pop().expect("balanced Markdown events").finish();
                    let parent = frames.last_mut().expect("Markdown root frame");
                    if is_block(end) {
                        parent.push_child(text);
                    } else {
                        parent.inline.append(text, "");
                    }
                }
                Event::Text(text) => frames.last_mut().unwrap().inline.push(&text, &self, range),
                Event::Code(text) => {
                    let range = inline_code_source_range(&self.text, &text, range);
                    frames.last_mut().unwrap().inline.push(&text, &self, range);
                }
                Event::SoftBreak => frames.last_mut().unwrap().inline.push("\n", &self, range),
                Event::Rule => frames
                    .last_mut()
                    .unwrap()
                    .push_child(ProjectedText::default()),
                _ => {}
            }
        }
        frames
            .pop()
            .expect("Markdown root frame")
            .finish()
            .region(id)
    }
}

fn inline_code_source_range(source: &str, text: &str, range: Range<usize>) -> Range<usize> {
    let raw = &source[range.clone()];
    let ticks = raw.bytes().take_while(|byte| *byte == b'`').count();
    if ticks == 0 || ticks * 2 > raw.len() {
        return range;
    }
    let mut start = range.start + ticks;
    let mut end = range.end - ticks;
    let content = &source[start..end];
    if content.starts_with(' ')
        && content.ends_with(' ')
        && !content.bytes().all(|byte| byte == b' ')
    {
        start += 1;
        end -= 1;
    }
    if &source[start..end] == text {
        start..end
    } else {
        range
    }
}

#[derive(Default)]
struct ProjectedText {
    text: String,
    sources: Vec<SearchSourceSpan>,
}

impl ProjectedText {
    fn append(&mut self, mut other: Self, separator: &str) {
        self.text.push_str(separator);
        let shift = self.text.encode_utf16().count();
        self.text.push_str(&other.text);
        for span in &mut other.sources {
            span.start += shift;
            span.end += shift;
        }
        self.sources.extend(other.sources);
    }

    fn push(&mut self, text: &str, source: &MappedSource, range: Range<usize>) {
        if text.is_empty() {
            return;
        }
        let start = self.text.encode_utf16().count();
        self.text.push_str(text);
        let end = start + text.encode_utf16().count();
        let raw = &source.text[range.clone()];
        if raw == text {
            let mut visible = start;
            for (byte, character) in raw.char_indices() {
                if let Some(origin) = &source.origins[range.start + byte] {
                    self.push_span(SearchSourceSpan {
                        item_id: origin.item_id.to_string(),
                        start: visible,
                        end: visible + character.len_utf16(),
                        source_start: origin.start,
                        source_end: origin.end,
                    });
                }
                visible += character.len_utf16();
            }
        } else {
            // Decoded entities, escaped punctuation and code normalization keep
            // the parser's raw span; decoded length is never used as raw offset.
            let mut origins = source.origins[range].iter().flatten().peekable();
            while let Some(first) = origins.next() {
                let mut last = first;
                while origins
                    .peek()
                    .is_some_and(|next| next.item_id == first.item_id)
                {
                    last = origins.next().unwrap();
                }
                self.push_span(SearchSourceSpan {
                    item_id: first.item_id.to_string(),
                    start,
                    end,
                    source_start: first.start,
                    source_end: last.end,
                });
            }
        }
    }

    fn push_span(&mut self, span: SearchSourceSpan) {
        if let Some(previous) = self.sources.last_mut() {
            if previous.item_id == span.item_id
                && previous.end == span.start
                && previous.source_end == span.source_start
                && previous.end - previous.start == previous.source_end - previous.source_start
                && span.end - span.start == span.source_end - span.source_start
            {
                previous.end = span.end;
                previous.source_end = span.source_end;
                return;
            }
        }
        self.sources.push(span);
    }

    fn region(self, id: &str) -> SearchRegion {
        SearchRegion {
            id: id.to_owned(),
            text: self.text,
            sources: self.sources,
        }
    }
}

struct TextFrame {
    end: Option<TagEnd>,
    children: Vec<ProjectedText>,
    inline: ProjectedText,
}

impl TextFrame {
    fn new(end: Option<TagEnd>) -> Self {
        Self {
            end,
            children: Vec::new(),
            inline: ProjectedText::default(),
        }
    }
    fn push_child(&mut self, text: ProjectedText) {
        if !self.inline.text.is_empty() {
            self.children.push(std::mem::take(&mut self.inline));
        }
        if !text.text.is_empty() {
            self.children.push(text);
        }
    }
    fn finish(mut self) -> ProjectedText {
        if matches!(self.end, Some(TagEnd::Image | TagEnd::HtmlBlock)) {
            return ProjectedText::default();
        }
        if !self.inline.text.is_empty() {
            self.children.push(self.inline);
        }
        let separator = match self.end {
            None
            | Some(
                TagEnd::BlockQuote(_)
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::Table
                | TagEnd::TableHead
                | TagEnd::TableRow,
            ) => "\n",
            _ => "",
        };
        let mut text = ProjectedText::default();
        for (index, child) in self.children.into_iter().enumerate() {
            text.append(child, if index == 0 { "" } else { separator });
        }
        if self.end == Some(TagEnd::CodeBlock) && text.text.ends_with('\n') {
            text.text.pop();
            let end = text.text.encode_utf16().count();
            text.sources.retain(|span| span.start < end);
            for span in &mut text.sources {
                span.end = span.end.min(end);
            }
        }
        text
    }
}

fn is_block(end: TagEnd) -> bool {
    matches!(
        end,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
    )
}

/// Fold each scalar separately so context-sensitive casing cannot move offsets.
/// Matches may start/end only at complete original scalar boundaries.
pub(super) fn search_ranges(text: &str, query: &str) -> Vec<SearchRange> {
    let needle: String = query.trim().chars().flat_map(char::to_lowercase).collect();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut folded = String::new();
    let mut boundaries = std::collections::HashMap::new();
    let mut offset = 0;
    boundaries.insert(0, 0);
    for character in text.chars() {
        folded.extend(character.to_lowercase());
        offset += character.len_utf16();
        boundaries.insert(folded.len(), offset);
    }
    let mut ranges = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = folded[cursor..].find(&needle) {
        let start = cursor + relative;
        let end = start + needle.len();
        if let (Some(&start), Some(&end)) = (boundaries.get(&start), boundaries.get(&end)) {
            ranges.push(SearchRange { start, end });
            cursor = cursor + relative + needle.len();
        } else {
            cursor = start + folded[start..].chars().next().unwrap().len_utf8();
        }
    }
    ranges
}

#[cfg(test)]
#[path = "transcript_search_projection/contract_tests.rs"]
pub(super) mod contract_tests;
