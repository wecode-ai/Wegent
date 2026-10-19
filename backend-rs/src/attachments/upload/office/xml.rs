// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The XML scanner the OOXML attachment parsers need.
//!
//! `python-docx` and `openpyxl` read part XML through lxml, so the port keeps
//! the observable parsing rules that matter for extracted text: element local
//! names (namespace prefixes are stripped, as the `xpath()` lookups these
//! parsers use do), attribute lookup by raw or local name, entity decoding,
//! and the XML line-ending normalization (`\r\n` and `\r` become `\n`). Text
//! nodes keep their whitespace exactly; callers decide what to trim.
//!
//! Comments, processing instructions, `DOCTYPE` declarations and `CDATA`
//! sections are handled; the scanner never builds a tree, so a large
//! worksheet streams instead of being materialized.

/// A start tag with its attributes in document order.
#[derive(Debug)]
pub(crate) struct StartTag {
    pub name: String,
    attributes: Vec<(String, String)>,
    pub self_closing: bool,
}

impl StartTag {
    /// The attribute written under exactly this name (`w:val`, `r:id`, ...).
    pub(crate) fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// The first attribute whose namespace-stripped name matches `local`.
    pub(crate) fn local(&self, local: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| local_name(key) == local)
            .map(|(_, value)| value.as_str())
    }
}

/// One scanner event.
#[derive(Debug)]
pub(crate) enum Event {
    Start(StartTag),
    End(String),
    Text(String),
}

/// The namespace-stripped name (`w:val` -> `val`).
pub(crate) fn local_name(name: &str) -> &str {
    match name.rfind(':') {
        Some(index) => &name[index + 1..],
        None => name,
    }
}

/// A malformed part: an element was left unclosed.
#[derive(Debug)]
pub(crate) struct XmlError;

/// One parsed element: its start tag, child elements and direct text nodes.
///
/// `python-docx` and `openpyxl` both materialize the parts they navigate, so
/// callers may hold a whole small part (`document.xml`, `sharedStrings.xml`)
/// while large sheets pull one row at a time through [`Tree::next_element`].
#[derive(Debug)]
pub(crate) struct Element {
    pub tag: StartTag,
    pub children: Vec<Element>,
    pub texts: Vec<String>,
}

impl Element {
    /// The element's namespace-stripped name.
    pub(crate) fn local(&self) -> &str {
        local_name(&self.tag.name)
    }

    /// An attribute by exact or namespace-stripped name.
    pub(crate) fn attr(&self, name: &str) -> Option<&str> {
        self.tag.attribute(name)
    }

    /// An attribute by namespace-stripped name.
    pub(crate) fn attr_local(&self, local: &str) -> Option<&str> {
        self.tag.local(local)
    }

    /// The element's own text, excluding child elements.
    pub(crate) fn direct_text(&self) -> String {
        self.texts.concat()
    }

    /// The first direct child with this namespace-stripped name.
    pub(crate) fn child(&self, local: &str) -> Option<&Element> {
        self.children.iter().find(|child| child.local() == local)
    }

    /// Every direct child with this namespace-stripped name.
    pub(crate) fn named_children<'b>(
        &'b self,
        local: &'b str,
    ) -> impl Iterator<Item = &'b Element> {
        self.children
            .iter()
            .filter(move |child| child.local() == local)
    }
}

/// A tree reader that materializes one element at a time.
pub(crate) struct Tree<'a> {
    reader: Reader<'a>,
    pending: Option<Event>,
    /// Names of the containers [`Tree::enter`] has descended into, so their
    /// end tags are consumed by the search instead of ending it.
    descended: Vec<String>,
}

impl<'a> Tree<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        Self {
            reader: Reader::new(text),
            pending: None,
            descended: Vec::new(),
        }
    }

    /// Parse the next complete element at the current position.
    pub(crate) fn next_element(&mut self) -> Result<Option<Element>, XmlError> {
        let Some(tag) = self.next_start_tag()? else {
            return Ok(None);
        };
        if tag.self_closing {
            return Ok(Some(Element {
                tag,
                children: Vec::new(),
                texts: Vec::new(),
            }));
        }
        Ok(Some(self.read_children(tag)?))
    }

    /// Scan forward to the first element with this namespace-stripped name.
    /// Unrelated preceding elements are parsed and dropped.
    pub(crate) fn find_element(&mut self, local: &str) -> Result<Option<Element>, XmlError> {
        while let Some(element) = self.next_element()? {
            if element.local() == local {
                return Ok(Some(element));
            }
        }
        Ok(None)
    }

    /// Enter the next element named `local`, leaving its children unread so a
    /// caller can stream them through [`Tree::next_element`] without
    /// materializing the container. The search descends through containers
    /// (a worksheet keeps its rows inside `sheetData`), skips empty elements
    /// and stops at the end of the enclosing element. A self-closing `local`
    /// is reported as absent.
    pub(crate) fn enter(&mut self, local: &str) -> Result<bool, XmlError> {
        loop {
            match self.read_event() {
                None => return Ok(false),
                Some(Event::Text(_)) => continue,
                Some(Event::Start(tag)) => {
                    if local_name(&tag.name) == local {
                        return Ok(!tag.self_closing);
                    }
                    if !tag.self_closing {
                        self.descended.push(local_name(&tag.name).to_string());
                    }
                }
                Some(Event::End(name)) => {
                    if self.descended.last().map(String::as_str) == Some(local_name(&name)) {
                        self.descended.pop();
                        continue;
                    }
                    // Hand the enclosing end tag back to the next reader call.
                    self.pending = Some(Event::End(name));
                    return Ok(false);
                }
            }
        }
    }

    /// The next start tag, stopping (without consuming) at an enclosing end tag
    /// or the end of the part.
    fn next_start_tag(&mut self) -> Result<Option<StartTag>, XmlError> {
        loop {
            match self.read_event() {
                None => return Ok(None),
                Some(event @ Event::End(_)) => {
                    self.pending = Some(event);
                    return Ok(None);
                }
                Some(Event::Text(_)) => continue,
                Some(Event::Start(tag)) => return Ok(Some(tag)),
            }
        }
    }

    fn read_event(&mut self) -> Option<Event> {
        match self.pending.take() {
            Some(event) => Some(event),
            None => self.reader.next_event(),
        }
    }

    fn read_children(&mut self, tag: StartTag) -> Result<Element, XmlError> {
        let mut element = Element {
            tag,
            children: Vec::new(),
            texts: Vec::new(),
        };
        loop {
            match self.read_event() {
                None => return Err(XmlError),
                Some(Event::End(name)) => {
                    if local_name(&name) != local_name(&element.tag.name) {
                        return Err(XmlError);
                    }
                    return Ok(element);
                }
                Some(Event::Text(text)) => element.texts.push(text),
                Some(Event::Start(child_tag)) => {
                    if child_tag.self_closing {
                        element.children.push(Element {
                            tag: child_tag,
                            children: Vec::new(),
                            texts: Vec::new(),
                        });
                    } else {
                        element.children.push(self.read_children(child_tag)?);
                    }
                }
            }
        }
    }
}

/// A pull scanner over one XML part.
pub(crate) struct Reader<'a> {
    text: &'a str,
    cursor: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        Self { text, cursor: 0 }
    }

    /// The next event, or `None` at the end of the part.
    pub(crate) fn next_event(&mut self) -> Option<Event> {
        loop {
            let rest = &self.text[self.cursor..];
            if rest.is_empty() {
                return None;
            }
            if let Some(text) = rest.strip_prefix("<![CDATA[") {
                let end = text.find("]]>").unwrap_or(text.len());
                let decoded = decode_text(&text[..end]);
                self.cursor += "<![CDATA[".len() + end + if end < text.len() { 3 } else { 0 };
                if !decoded.is_empty() {
                    return Some(Event::Text(decoded));
                }
                continue;
            }
            if !rest.starts_with('<') {
                let end = rest.find('<').unwrap_or(rest.len());
                let decoded = decode_text(&rest[..end]);
                self.cursor += end;
                if !decoded.is_empty() {
                    return Some(Event::Text(decoded));
                }
                continue;
            }
            if let Some(consumed) = skip_markup(rest) {
                self.cursor += consumed;
                continue;
            }
            return self.read_tag();
        }
    }

    /// Read one start or end tag.
    fn read_tag(&mut self) -> Option<Event> {
        let rest = &self.text[self.cursor..];
        if let Some(after) = rest.strip_prefix("</") {
            let end = after.find('>')?;
            let name = after[..end].trim().to_string();
            self.cursor += 2 + end + 1;
            return Some(Event::End(name));
        }
        let body = &rest[1..];
        let end = find_tag_end(body)?;
        let body = &body[..end];
        let self_closing = body.trim_end().ends_with('/');
        let content = body.trim_end().trim_end_matches('/');
        let name_end = content.find(char::is_whitespace).unwrap_or(content.len());
        let name = content[..name_end].to_string();
        let attributes = parse_attributes(&content[name_end..]);
        self.cursor += 1 + end + 1;
        Some(Event::Start(StartTag {
            name,
            attributes,
            self_closing,
        }))
    }
}

/// Consume a comment, processing instruction or declaration; `None` means the
/// text at the cursor starts a real element tag.
fn skip_markup(rest: &str) -> Option<usize> {
    for (prefix, terminator) in [("<!--", "-->"), ("<?", "?>"), ("<!", ">")] {
        if let Some(body) = rest.strip_prefix(prefix) {
            return Some(match body.find(terminator) {
                Some(index) => prefix.len() + index + terminator.len(),
                None => rest.len(),
            });
        }
    }
    None
}

/// The offset of the tag's closing `>`, ignoring quotes inside attribute values.
fn find_tag_end(body: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (index, ch) in body.char_indices() {
        match quote {
            Some(open) => {
                if ch == open {
                    quote = None;
                }
            }
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                '>' => return Some(index),
                _ => {}
            },
        }
    }
    None
}

/// Parse the attribute list of a start tag.
fn parse_attributes(content: &str) -> Vec<(String, String)> {
    let mut attributes = Vec::new();
    let mut cursor = 0;
    while cursor < content.len() {
        let Some(ch) = content[cursor..].chars().next() else {
            break;
        };
        if ch.is_whitespace() {
            cursor += ch.len_utf8();
            continue;
        }
        let name_start = cursor;
        while cursor < content.len() {
            let current = content[cursor..].chars().next().unwrap_or(' ');
            if current.is_whitespace() || current == '=' {
                break;
            }
            cursor += current.len_utf8();
        }
        let name = content[name_start..cursor].to_string();
        skip_whitespace(content, &mut cursor);
        let mut value = String::new();
        if content[cursor..].starts_with('=') {
            cursor += 1;
            skip_whitespace(content, &mut cursor);
            if let Some(quote) = content[cursor..]
                .chars()
                .next()
                .filter(|c| *c == '"' || *c == '\'')
            {
                cursor += quote.len_utf8();
                let value_start = cursor;
                while cursor < content.len() && !content[cursor..].starts_with(quote) {
                    cursor += content[cursor..].chars().next().unwrap().len_utf8();
                }
                value = decode_attribute(&content[value_start..cursor]);
                if content[cursor..].starts_with(quote) {
                    cursor += quote.len_utf8();
                }
            }
        }
        attributes.push((name, value));
    }
    attributes
}

fn skip_whitespace(content: &str, cursor: &mut usize) {
    while *cursor < content.len() {
        match content[*cursor..].chars().next() {
            Some(ch) if ch.is_whitespace() => *cursor += ch.len_utf8(),
            _ => break,
        }
    }
}

/// XML text decoding: entities first, then line-ending normalization.
fn decode_text(raw: &str) -> String {
    let decoded = decode_entities(raw);
    if decoded.contains('\r') {
        decoded.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        decoded
    }
}

/// XML attribute-value decoding: entities, then whitespace normalization.
fn decode_attribute(raw: &str) -> String {
    let decoded = decode_entities(raw);
    if decoded.contains('\n') || decoded.contains('\r') || decoded.contains('\t') {
        decoded
            .replace("\r\n", " ")
            .replace(['\r', '\n', '\t'], " ")
    } else {
        decoded
    }
}

fn decode_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let Some(end) = tail.find(';').filter(|end| *end <= 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        match decode_entity(entity) {
            Some(ch) => {
                out.push(ch);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => {
            // `&#x1F600;` / `&#128512;`: OOXML writers escape non-ASCII text
            // this way, so the numeric forms must decode.
            if let Some(digits) = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
            {
                return u32::from_str_radix(digits, 16)
                    .ok()
                    .and_then(char::from_u32);
            }
            let digits = entity.strip_prefix('#')?;
            digits.parse::<u32>().ok().and_then(char::from_u32)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(text: &str) -> Vec<(String, Vec<(String, String)>)> {
        let mut reader = Reader::new(text);
        let mut events = Vec::new();
        while let Some(event) = reader.next_event() {
            match event {
                Event::Start(tag) => events.push((tag.name, tag.attributes.clone())),
                Event::End(name) => events.push((format!("/{name}"), Vec::new())),
                Event::Text(value) => events.push((format!("text:{value}"), Vec::new())),
            }
        }
        events
    }

    #[test]
    fn elements_text_and_namespaces_are_reported_in_order() {
        let events = collect(
            r#"<?xml version="1.0"?><!-- c --><w:p xmlns:w="w"><w:r><w:t xml:space="preserve"> a&amp;b </w:t></w:r><w:br/></w:p>"#,
        );
        assert_eq!(events[0].0, "w:p");
        assert_eq!(events[1].0, "w:r");
        assert_eq!(events[2].0, "w:t");
        assert_eq!(events[3].0, "text: a&b ");
        assert_eq!(events[4].0, "/w:t");
        assert_eq!(events[5].0, "/w:r");
        assert_eq!(events[6].0, "w:br");
        assert!(events[6].1.is_empty());
        assert_eq!(events[7].0, "/w:p");
    }

    #[test]
    fn attributes_are_read_by_raw_and_local_name() {
        let mut reader = Reader::new(r#"<c r="B2" s="14" t="s" w:val="restart" r:id="rId1"/>"#);
        let Some(Event::Start(tag)) = reader.next_event() else {
            panic!("expected a start tag");
        };
        assert!(tag.self_closing);
        assert_eq!(tag.attribute("r"), Some("B2"));
        assert_eq!(tag.attribute("w:val"), Some("restart"));
        assert_eq!(tag.local("val"), Some("restart"));
        assert_eq!(tag.local("id"), Some("rId1"));
        assert_eq!(tag.attribute("val"), None);
    }

    #[test]
    fn numeric_character_references_decode() {
        assert_eq!(
            decode_entities("&#25628;&#32034;&#35789;"),
            "\u{641c}\u{7d22}\u{8bcd}"
        );
        assert_eq!(decode_entities("&#x641c;&#x7d22;"), "\u{641c}\u{7d22}");
        assert_eq!(decode_entities("a&#10;b"), "a\nb");
        assert_eq!(decode_entities("&amp;&lt;&gt;&quot;&apos;"), "&<>\"'");
        // Undefined named entities stay as written; the five predefined ones
        // are the only names XML defines.
        assert_eq!(decode_entities("&copy;"), "&copy;");
    }

    #[test]
    fn cdata_and_carriage_returns_are_normalized() {
        let events = collect("<a><![CDATA[x<y]]></a>");
        assert_eq!(events[0].0, "a");
        assert_eq!(events[1].0, "text:x<y");
        let mut reader = Reader::new("<a>line1\r\nline2\rend</a>");
        reader.next_event();
        let Some(Event::Text(text)) = reader.next_event() else {
            panic!("expected text");
        };
        assert_eq!(text, "line1\nline2\nend");
    }

    #[test]
    fn quoted_greater_than_does_not_end_a_tag() {
        let mut reader = Reader::new(r#"<a b=">" c='1'/>>"#);
        let Some(Event::Start(tag)) = reader.next_event() else {
            panic!("expected a start tag");
        };
        assert_eq!(tag.attribute("b"), Some(">"));
        assert_eq!(tag.attribute("c"), Some("1"));
        assert!(matches!(reader.next_event(), Some(Event::Text(text)) if text == ">"));
    }
}
