// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTML metadata extraction for `GET /api/utils/url-metadata`: the
//! `_extract_title`, `_extract_description`, and `_extract_favicon` helpers of
//! `app.services.url_metadata`.
//!
//! The source is a set of `re.search` patterns over the downloaded document.
//! These helpers reproduce their observable selection rules, including
//! document order, greedy backtracking, and the fact that attribute names are
//! matched as text (so `href=` also matches the tail of `data-base-href=`).

/// `_extract_title`: Open Graph, then Twitter card, then `<title>`.
pub(crate) fn extract_title(html: &str) -> Option<String> {
    if let Some(title) = non_empty(extract_meta_content(html, "og:title", "property")) {
        return Some(title);
    }
    if let Some(title) = non_empty(extract_meta_content(html, "twitter:title", "name")) {
        return Some(title);
    }
    extract_title_tag(html)
}

/// `_extract_description`: Open Graph, then Twitter card, then `name`.
pub(crate) fn extract_description(html: &str) -> Option<String> {
    if let Some(description) = non_empty(extract_meta_content(html, "og:description", "property")) {
        return Some(description);
    }
    if let Some(description) = non_empty(extract_meta_content(html, "twitter:description", "name"))
    {
        return Some(description);
    }
    non_empty(extract_meta_content(html, "description", "name"))
}

/// `_extract_meta_content`: the content of the first `<meta>` tag whose
/// `attr` (`property` or `name`) equals `property_name`. The attribute may
/// precede or follow `content`, mirroring the source's two regular expressions
/// in order.
fn extract_meta_content(html: &str, property_name: &str, attr: &str) -> Option<String> {
    let bodies = tag_bodies(html, "meta");

    // `<meta attr="property_name" content="...">`
    for body in &bodies {
        if !starts_with_space(body) {
            continue;
        }
        let attributes = parse_attributes(body);
        if attributes.len() < 2 {
            continue;
        }
        if attributes[0].name.eq_ignore_ascii_case(attr)
            && attributes[0].value.eq_ignore_ascii_case(property_name)
            && attributes[1].name.eq_ignore_ascii_case("content")
            && attributes[1].quoted
        {
            return Some(attributes[1].value.trim().to_owned());
        }
    }

    // `<meta content="..." attr="property_name">`
    for body in &bodies {
        if !starts_with_space(body) {
            continue;
        }
        let attributes = parse_attributes(body);
        if attributes.len() < 2 {
            continue;
        }
        if attributes[0].name.eq_ignore_ascii_case("content")
            && attributes[0].quoted
            && attributes[1].name.eq_ignore_ascii_case(attr)
            && attributes[1].value.eq_ignore_ascii_case(property_name)
        {
            return Some(attributes[0].value.trim().to_owned());
        }
    }

    None
}

/// The `<title[^>]*>([^<]+)</title>` fallback, case-insensitive.
fn extract_title_tag(html: &str) -> Option<String> {
    let bytes = html.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let name_end = name_start + 5;
        if name_end <= bytes.len()
            && bytes[name_start..name_end].eq_ignore_ascii_case(b"title")
            && let Some(gt) = html[name_end..].find('>')
        {
            let text_start = name_end + gt + 1;
            if let Some(lt) = html[text_start..].find('<') {
                let text = &html[text_start..text_start + lt];
                let close = text_start + lt;
                let close_end = close + 8;
                if !text.is_empty()
                    && close_end <= bytes.len()
                    && bytes[close..close_end].eq_ignore_ascii_case(b"</title>")
                {
                    return Some(text.trim().to_owned());
                }
            }
        }
        index += 1;
    }
    None
}

/// `_extract_favicon`: a `rel="icon"`/`rel="shortcut icon"` link, then an
/// `apple-touch-icon`, then `scheme://netloc/favicon.ico`. Always returns a
/// URL for a parseable base URL.
///
/// Each source pattern is a `re.search` over the whole document, so the first
/// matching `<link>` element in document order wins. Within one element the
/// pattern's greedy `[^>]+` between the leading and trailing attributes makes
/// backtracking choose the last trailing value of the element: on GitHub's
/// page, `<link rel="icon" ... href=".../favicon.svg"
/// data-base-href=".../favicon">` therefore yields the `data-base-href` value,
/// matching the recorded `.../favicons/favicon`.
pub(crate) fn extract_favicon(html: &str, base_url: &str) -> String {
    // Pattern order of the source: `rel` before `href`, `href` before `rel`,
    // then `apple-touch-icon`.
    for (kind, reverse) in [
        (IconKind::Icon, false),
        (IconKind::Icon, true),
        (IconKind::AppleTouch, false),
    ] {
        for body in tag_bodies(html, "link") {
            if let Some(href) = regex_favicon_href(body, kind, reverse) {
                return normalize_favicon(href, base_url);
            }
        }
    }
    fallback_favicon(base_url)
}

/// Which favicon relation a `<link>` body must carry.
#[derive(Clone, Copy, PartialEq, Eq)]
enum IconKind {
    Icon,
    AppleTouch,
}

impl IconKind {
    /// Whether a quoted `rel` value satisfies this pattern's relation.
    fn matches(self, rel: &str) -> bool {
        match self {
            IconKind::Icon => rel_is_icon(rel),
            IconKind::AppleTouch => rel.eq_ignore_ascii_case("apple-touch-icon"),
        }
    }
}

/// Evaluate one source favicon pattern against a single `<link>` tag body.
///
/// `reverse` corresponds to the source's second pattern, where the quoted
/// `href` precedes `rel`. Both branches reproduce the regex's greedy
/// `[^>]+` backtracking: the captured value is the last trailing attribute
/// value such that a matching leading attribute precedes it. On GitHub's page
/// that selects `data-base-href` over the plain `href`, yielding the recorded
/// `.../favicons/favicon`.
fn regex_favicon_href(body: &str, kind: IconKind, reverse: bool) -> Option<&str> {
    if reverse {
        favicon_href_before_rel(body, kind)
    } else {
        favicon_rel_before_href(body, kind)
    }
}

/// The first source pattern: `<link[^>]+rel=["']...["'][^>]+href=["'](...)["']`.
///
/// Anchoring on the first matching `rel` yields the same capture as the
/// regex's greedy leading `[^>]+`: the last `href` after that anchor is also
/// the last `href` after any later matching `rel`, and a later matching `rel`
/// without a trailing `href` backtracks to the earlier anchor anyway.
fn favicon_rel_before_href(body: &str, kind: IconKind) -> Option<&str> {
    let anchor = rel_anchor(body, kind)?;
    let mut index = first_trailing_attribute(body, anchor.next_offset);
    let mut captured = None;
    while let Some(href) = find_attribute(body, index, AttrKind::Href) {
        if !href.value.is_empty() {
            captured = Some(href.value.trim());
        }
        index = first_trailing_attribute(body, href.next_offset);
    }
    captured
}

/// The second source pattern: `<link[^>]+href=["'](...)["'][^>]+rel=["']...["']`.
///
/// The greedy leading `[^>]+href=` prefers the last `href` that still has a
/// matching `rel` after it, so keep scanning and remember the last such
/// `href`.
fn favicon_href_before_rel(body: &str, kind: IconKind) -> Option<&str> {
    // `<link[^>]+` needs at least one character before the attribute name.
    let mut index = 1;
    let mut captured = None;
    while let Some(href) = find_attribute(body, index, AttrKind::Href) {
        index = first_trailing_attribute(body, href.next_offset);
        if href.value.is_empty() {
            continue;
        }
        if rel_follows(body, kind, index) {
            captured = Some(href.value.trim());
        }
    }
    captured
}

/// The first `rel` attribute whose value satisfies `kind`.
fn rel_anchor<'a>(body: &'a str, kind: IconKind) -> Option<LocatedAttr<'a>> {
    let mut index = 1;
    while let Some(rel) = find_attribute(body, index, AttrKind::Rel) {
        if kind.matches(rel.value) {
            return Some(rel);
        }
        index = first_trailing_attribute(body, rel.next_offset);
    }
    None
}

/// Whether a `rel` satisfying `kind` occurs at or after `index`.
fn rel_follows(body: &str, kind: IconKind, index: usize) -> bool {
    let mut index = index;
    while let Some(rel) = find_attribute(body, index, AttrKind::Rel) {
        if kind.matches(rel.value) {
            return true;
        }
        index = first_trailing_attribute(body, rel.next_offset);
    }
    false
}

/// The earliest position at which a following attribute may start: the
/// source's `[^>]+` between two attributes needs at least one character, so
/// the next attribute name cannot begin immediately after the closing quote.
fn first_trailing_attribute(body: &str, next_offset: usize) -> usize {
    next_offset.saturating_add(1).min(body.len())
}

/// The attribute kind a `find_attribute` scan is looking for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AttrKind {
    Rel,
    Href,
}

impl AttrKind {
    /// The attribute name this kind scans for.
    fn name(self) -> &'static str {
        match self {
            AttrKind::Rel => "rel",
            AttrKind::Href => "href",
        }
    }
}

/// One located attribute in a tag body: its raw quoted value and the offset
/// just past the value, so scanning can continue after it.
struct LocatedAttr<'a> {
    value: &'a str,
    next_offset: usize,
}

/// Find the next occurrence of a `kind` attribute in `body` at or after
/// `from`, returning its raw quoted value and the offset past the value.
///
/// This mirrors what the source's `<link[^>]+rel=["\']...` family of patterns
/// can reach: an attribute is `name="value"` with a quoted value, and the scan
/// never leaves the tag body (callers pass only the text between `<link` and
/// `>`).
///
/// The matched name may itself end in the sought name (Python's `href=`
/// matches inside `data-base-href=` just as well), so a candidate is accepted
/// whenever the characters immediately before `=` end with `name`, provided
/// the name starts at or after `from`.
fn find_attribute<'a>(body: &'a str, from: usize, kind: AttrKind) -> Option<LocatedAttr<'a>> {
    let name = kind.name();
    let name_len = name.len();
    let bytes = body.as_bytes();
    let mut index = from;
    while index < bytes.len() {
        if bytes[index] != b'=' {
            index += 1;
            continue;
        }
        // The matched text is the `name.len()` characters immediately before
        // `=`, and the regex requires it to start at or after the scan
        // position.
        if index < name_len || index - name_len < from {
            index += 1;
            continue;
        }
        let name_start = index - name_len;
        let Some(candidate) = body.get(name_start..index) else {
            index += 1;
            continue;
        };
        if !candidate.eq_ignore_ascii_case(name) {
            index += 1;
            continue;
        }
        let mut value_index = index + 1;
        while value_index < bytes.len() && bytes[value_index].is_ascii_whitespace() {
            value_index += 1;
        }
        if value_index < bytes.len() && (bytes[value_index] == b'"' || bytes[value_index] == b'\'')
        {
            let quote = bytes[value_index];
            let value_start = value_index + 1;
            if let Some(position) = body[value_start..].find(quote as char) {
                return Some(LocatedAttr {
                    value: &body[value_start..value_start + position],
                    next_offset: value_start + position + 1,
                });
            }
        }
        index += 1;
    }
    None
}

/// `(?:shortcut\s+)?icon`, case-insensitive against the whole `rel` value.
fn rel_is_icon(rel: &str) -> bool {
    if rel.eq_ignore_ascii_case("icon") {
        return true;
    }
    let Some(prefix) = rel.get(.."shortcut".len()) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("shortcut") {
        return false;
    }
    let after = &rel["shortcut".len()..];
    let trimmed = after.trim_start_matches(char::is_whitespace);
    after.len() > trimmed.len() && trimmed.eq_ignore_ascii_case("icon")
}

/// Resolve a favicon href like the source: absolute URLs pass through,
/// protocol-relative URLs gain `https:`, and relative URLs join the base.
fn normalize_favicon(href: &str, base_url: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_owned();
    }
    if href.starts_with("//") {
        return format!("https:{href}");
    }
    url::Url::parse(base_url)
        .and_then(|base| base.join(href))
        .map_or_else(|_| href.to_owned(), |joined| joined.to_string())
}

/// `scheme://netloc/favicon.ico` fallback.
fn fallback_favicon(base_url: &str) -> String {
    let Ok(parsed) = url::Url::parse(base_url) else {
        return String::new();
    };
    let Some(host) = parsed.host_str() else {
        return String::new();
    };
    match parsed.port() {
        Some(port) => format!("{}://{host}:{port}/favicon.ico", parsed.scheme()),
        None => format!("{}://{host}/favicon.ico", parsed.scheme()),
    }
}

/// Returns `value` when it is non-empty, mirroring the source's `if x:` truth
/// checks on optional metadata.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// One attribute of a tag body, borrowed from the source HTML.
struct TagAttr<'a> {
    name: &'a str,
    value: &'a str,
    quoted: bool,
}

fn starts_with_space(body: &str) -> bool {
    body.chars().next().is_some_and(char::is_whitespace)
}

/// Iterate the bodies (the text between the tag name and its terminating `>`)
/// of every `<name ...>` opening tag, in source order.
fn tag_bodies<'a>(html: &'a str, name: &str) -> Vec<&'a str> {
    let bytes = html.as_bytes();
    let name_bytes = name.as_bytes();
    let mut bodies = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let name_end = name_start + name_bytes.len();
        if name_end <= bytes.len()
            && bytes[name_start..name_end].eq_ignore_ascii_case(name_bytes)
            && let Some(gt) = html[name_end..].find('>')
        {
            bodies.push(&html[name_end..name_end + gt]);
            index = name_end + gt + 1;
            continue;
        }
        index += 1;
    }
    bodies
}

/// Parse a tag body's attributes in source order. Values are unquoted; an
/// unterminated or missing value yields an empty `value`.
fn parse_attributes(body: &str) -> Vec<TagAttr<'_>> {
    let bytes = body.as_bytes();
    let mut attributes = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let name_start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'=' {
            index += 1;
        }
        let name = &body[name_start..index];
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index < bytes.len() && bytes[index] == b'=' {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            if index < bytes.len() && (bytes[index] == b'"' || bytes[index] == b'\'') {
                let quote = bytes[index];
                index += 1;
                let value_start = index;
                while index < bytes.len() && bytes[index] != quote {
                    index += 1;
                }
                let value = &body[value_start..index];
                if index < bytes.len() {
                    index += 1;
                }
                attributes.push(TagAttr {
                    name,
                    value,
                    quoted: true,
                });
            } else {
                let value_start = index;
                while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                attributes.push(TagAttr {
                    name,
                    value: &body[value_start..index],
                    quoted: false,
                });
            }
        } else {
            attributes.push(TagAttr {
                name,
                value: "",
                quoted: false,
            });
        }
    }
    attributes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic document page title and favicon-bearing `<head>` fragment.
    const DOCS_HEAD: &str = r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" id="favicon" href="//cdn.example.invalid/icons/docs.ico" type="image/x-icon" />
      <link rel="preconnect" href="https://login.example.invalid/" />
      <title>Example Docs - Example identity authentication</title>
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta
      name="viewport"
      content="viewport-fit=cover, width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
    />
  </head>
</html>"#;

    #[test]
    fn extracts_document_page_metadata() {
        assert_eq!(
            extract_title(DOCS_HEAD).as_deref(),
            Some("Example Docs - Example identity authentication")
        );
        assert_eq!(extract_description(DOCS_HEAD), None);
        assert_eq!(
            extract_favicon(
                DOCS_HEAD,
                "https://docs.example.invalid/documents/example?view=team"
            ),
            "https://cdn.example.invalid/icons/docs.ico"
        );
    }

    #[test]
    fn falls_back_to_the_site_favicon_when_no_link_matches() {
        assert_eq!(
            extract_favicon(
                "<html><head></head></html>",
                "https://media.example.invalid/video/example"
            ),
            "https://media.example.invalid/favicon.ico"
        );
        assert_eq!(extract_title("<html><head></head></html>"), None);
    }

    /// The recorded GitHub page: the `rel="icon"` element carries both
    /// `href=".../favicon.svg"` and `data-base-href=".../favicon"`. The
    /// source's greedy `[^>]+` backtracking selects the LAST `href` value in
    /// the element, so Python records `.../favicons/favicon` — the value of
    /// `data-base-href` — not the `.svg` href.
    #[test]
    fn favicon_uses_the_last_href_value_of_the_matching_link_element() {
        let html = concat!(
            r##"<head>"##,
            r##"<link rel="fluid-icon" href="https://github.com/fluidicon.png" title="GitHub">"##,
            r##"<link rel="mask-icon" href="https://github.githubassets.com/assets/pinned-octocat-093da3e6fa40.svg" color="#000000">"##,
            r##"<link rel="alternate icon" class="js-site-favicon" type="image/png" href="https://github.githubassets.com/favicons/favicon.png">"##,
            r##"<link rel="icon" class="js-site-favicon" type="image/svg+xml" href="https://github.githubassets.com/favicons/favicon.svg" data-base-href="https://github.githubassets.com/favicons/favicon">"##,
            r##"</head>"##
        );
        assert_eq!(
            extract_favicon(html, "https://github.com/example-org/example-repo"),
            "https://github.githubassets.com/favicons/favicon"
        );
        // Without the trailing `data-base-href`, the plain `href` value wins.
        assert_eq!(
            extract_favicon(
                r#"<link rel="icon" href="/static/favicon.svg">"#,
                "https://example.com/page"
            ),
            "https://example.com/static/favicon.svg"
        );
        // An `href` inside another attribute's value still matches, like the
        // source regex's bare `href=` text scan (Python returns `/x.svg`
        // here); the implementation reproduces that text-level behavior.
        assert_eq!(
            extract_favicon(
                r#"<link rel="icon" data-note="see href='/x.svg'">"#,
                "https://example.com/page"
            ),
            "https://example.com/x.svg"
        );
    }

    /// The source tries the `rel`-before-`href` pattern over the whole
    /// document before the `href`-before-`rel` pattern, so a later document
    /// element that matches the first pattern wins.
    #[test]
    fn favicon_prefers_the_rel_before_href_pattern_across_the_document() {
        let html = concat!(
            r#"<head>"#,
            r#"<link href="/early-icon.png" rel="icon">"#,
            r#"<link rel="shortcut icon" href="/late.png">"#,
            r#"</head>"#
        );
        assert_eq!(
            extract_favicon(html, "https://example.com"),
            "https://example.com/late.png"
        );
    }

    /// When no element matches the first pattern, the `href`-before-`rel`
    /// pattern applies. Its greedy leading `[^>]+href=` takes the last `href`
    /// that still has a matching `rel` after it.
    #[test]
    fn favicon_falls_back_to_the_href_before_rel_pattern() {
        assert_eq!(
            extract_favicon(r#"<link href="/a" rel="icon">"#, "https://example.com"),
            "https://example.com/a"
        );
        assert_eq!(
            extract_favicon(
                r#"<link href="/a" href="/b" rel="icon">"#,
                "https://example.com"
            ),
            "https://example.com/b"
        );
        assert_eq!(
            extract_favicon(
                r#"<link href="/early" rel="stylesheet"><link href="/late" rel="icon">"#,
                "https://example.com"
            ),
            "https://example.com/late"
        );
        // A trailing `rel` that is not a favicon relation backtracks to the
        // earlier matching one, whose trailing `href` is the last `href`.
        assert_eq!(
            extract_favicon(
                r#"<link href="/a" rel="icon" href="/b" rel="stylesheet">"#,
                "https://example.com"
            ),
            "https://example.com/b"
        );
        // An empty `href` cannot satisfy the `([^"\']+)` capture.
        assert_eq!(
            extract_favicon(
                r#"<link href="" href="/b" rel="icon">"#,
                "https://example.com"
            ),
            "https://example.com/b"
        );
    }

    /// Every `[^>]+` in the source patterns needs at least one character, so
    /// attributes must be separated and `<link` must be followed by a
    /// character before an attribute name.
    #[test]
    fn favicon_requires_the_source_pattern_separators() {
        assert_eq!(
            extract_favicon(r#"<link rel="icon"href="/a">"#, "https://example.com"),
            "https://example.com/favicon.ico"
        );
        assert_eq!(
            extract_favicon(r#"<linkrel="icon" href="/a">"#, "https://example.com"),
            "https://example.com/favicon.ico"
        );
    }

    #[test]
    fn meta_content_prefers_open_graph_over_title_tag() {
        let html = r#"<meta property="og:title" content="OG title"><title>Tag title</title>"#;
        assert_eq!(extract_title(html).as_deref(), Some("OG title"));
        let html = r#"<meta name="twitter:title" content="Tweet title"><title>Tag title</title>"#;
        assert_eq!(extract_title(html).as_deref(), Some("Tweet title"));
        let html = r#"<meta content="Content first" name="twitter:title">"#;
        assert_eq!(extract_title(html).as_deref(), Some("Content first"));
        let html = r#"<meta property="og:title" content="">"#;
        assert_eq!(extract_title(html), None);
    }

    #[test]
    fn description_supports_twitter_and_plain_meta() {
        let html = r#"<meta name="twitter:description" content="tweet">"#;
        assert_eq!(extract_description(html).as_deref(), Some("tweet"));
        let html = r#"<meta name="description" content="plain">"#;
        assert_eq!(extract_description(html).as_deref(), Some("plain"));
        assert_eq!(extract_description("<html></html>"), None);
    }
}
