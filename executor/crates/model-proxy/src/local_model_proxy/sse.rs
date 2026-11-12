//! SSE framing and payload handling shared by all local model protocols.

use serde_json::Value;

pub(super) struct Event<'a> {
    pub name: Option<&'a str>,
    pub data: String,
}

impl<'a> Event<'a> {
    pub fn parse(block: &'a str) -> Option<Self> {
        let mut name = None;
        let mut data = Vec::new();
        for line in event_lines(block) {
            let line = line.trim_start_matches('\u{feff}').trim_start();
            if let Some(value) = line.strip_prefix("event:") {
                name = Some(value.trim());
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value));
            }
        }
        (!data.is_empty()).then(|| Self {
            name,
            data: data.join("\n"),
        })
    }
}

pub(super) fn json(block: &str) -> Option<Value> {
    serde_json::from_str(&Event::parse(block)?.data).ok()
}

pub(super) fn blocks(mut input: &str) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        input = input.trim_start_matches(['\r', '\n']);
        if input.is_empty() {
            return None;
        }
        let (end, consumed) = frame_end(input).unwrap_or((input.len(), input.len()));
        let block = &input[..end];
        input = &input[consumed..];
        Some(block)
    })
}

// Consume the first empty line, independent of the line endings used elsewhere.
fn frame_end(input: &str) -> Option<(usize, usize)> {
    let mut line_start = 0;
    let mut previous_end = 0;
    while let Some((end, next)) = line_end(input, line_start) {
        if end == line_start {
            return Some((previous_end, next));
        }
        previous_end = end;
        line_start = next;
    }
    None
}

fn line_end(input: &str, start: usize) -> Option<(usize, usize)> {
    let end = start + input[start..].find(['\r', '\n'])?;
    let crlf = input.as_bytes()[end] == b'\r' && input.as_bytes().get(end + 1) == Some(&b'\n');
    Some((end, end + if crlf { 2 } else { 1 }))
}

fn event_lines(mut input: &str) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        if input.is_empty() {
            return None;
        }
        let (end, next) = line_end(input, 0).unwrap_or((input.len(), input.len()));
        let line = &input[..end];
        input = &input[next..];
        Some(line)
    })
}

pub(crate) fn take_sse_block(buffer: &mut String) -> Option<String> {
    // Empty frames carry no data. This also consumes a split CRLF's trailing LF
    // after its CR has already dispatched the preceding event.
    let leading = buffer.len() - buffer.trim_start_matches(['\r', '\n']).len();
    buffer.drain(..leading);
    let (end, consumed) = frame_end(buffer)?;
    let block = buffer[..end].to_owned();
    buffer.drain(..consumed);
    Some(block)
}

pub(super) fn rewrite_data(block: &str, value: &Value) -> String {
    let mut lines = Vec::new();
    let mut replaced = false;
    for raw_line in event_lines(block) {
        let line = raw_line.trim_start_matches('\u{feff}').trim_start();
        if line.starts_with("data:") {
            if !replaced {
                lines.push(format!("data: {value}"));
                replaced = true;
            }
        } else {
            lines.push(raw_line.to_owned());
        }
    }
    lines.join("\n")
}

pub(crate) fn append_stream_utf8(
    buffer: &mut String,
    pending_utf8: &mut Vec<u8>,
    chunk: &[u8],
) -> Result<(), std::io::Error> {
    pending_utf8.extend_from_slice(chunk);
    match std::str::from_utf8(pending_utf8) {
        Ok(text) => {
            buffer.push_str(text);
            pending_utf8.clear();
            Ok(())
        }
        Err(error) => {
            let valid_up_to = error.valid_up_to();
            let error_len = error.error_len();
            if valid_up_to > 0 {
                let valid = std::str::from_utf8(&pending_utf8[..valid_up_to])
                    .expect("UTF-8 validator should identify a valid prefix");
                buffer.push_str(valid);
                pending_utf8.drain(..valid_up_to);
            }
            if error_len.is_some() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Upstream stream contains invalid UTF-8",
                ));
            }
            Ok(())
        }
    }
}

pub(crate) fn finish_stream_utf8(pending_utf8: &[u8]) -> Result<(), std::io::Error> {
    if pending_utf8.is_empty() {
        return Ok(());
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        "Upstream stream ended with an incomplete UTF-8 sequence",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_lines_allow_both_line_endings_at_the_same_boundary() {
        for separator in ["\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n"] {
            let mut input = format!("data: 1{separator}data: 2\n\n");
            assert_eq!(take_sse_block(&mut input).as_deref(), Some("data: 1"));
            assert_eq!(take_sse_block(&mut input).as_deref(), Some("data: 2"));
            assert!(input.is_empty());
        }
    }

    #[test]
    fn cr_only_lines_parse_and_rewrite_the_entire_payload() {
        let source = "event: message\rdata: {\rdata: \"before\": true}\rid: keep";
        assert_eq!(json(source), Some(json!({"before":true})));
        let rewritten = rewrite_data(source, &json!({"after":"中文"}));
        assert_eq!(json(&rewritten), Some(json!({"after":"中文"})));
        assert!(rewritten.lines().any(|line| line == "id: keep"));
    }

    #[test]
    fn cr_terminated_frame_is_ready_without_another_chunk_or_eof() {
        let mut input = "data: 1\r\r".to_owned();
        assert_eq!(take_sse_block(&mut input).as_deref(), Some("data: 1"));
        assert!(input.is_empty());
    }

    #[test]
    fn split_crlf_terminator_is_consumed_as_one_line_ending() {
        let mut input = "data: 1\r\n\r".to_owned();
        assert_eq!(take_sse_block(&mut input).as_deref(), Some("data: 1"));
        input.push('\n');
        assert!(take_sse_block(&mut input).is_none());
        assert!(input.is_empty());
        input.push_str("data: 2\n\n");
        assert_eq!(take_sse_block(&mut input).as_deref(), Some("data: 2"));
        assert!(input.is_empty());
    }

    #[test]
    fn multiline_data_keeps_payload_spaces_and_empty_data_lines() {
        let event = Event::parse(
            "\u{feff}: comment\r\nevent: message\r\ndata:  first\r\ndata:\r\ndata: second ",
        )
        .unwrap();
        assert_eq!(event.name, Some("message"));
        assert_eq!(event.data, " first\n\nsecond ");
    }

    #[test]
    fn rewritten_payload_replaces_all_data_lines_and_preserves_metadata() {
        let source = ": keep\r\nid: event-1\r\nevent: message\r\ndata: {\r\ndata: \"before\": true}\r\nretry: 1000";
        let expected = json!({"after":"中文"});
        let rewritten = rewrite_data(source, &expected);
        assert_eq!(json(&rewritten), Some(expected));
        assert_eq!(
            rewritten
                .lines()
                .filter(|line| line.starts_with("data:"))
                .count(),
            1
        );
        for metadata in [": keep", "id: event-1", "event: message", "retry: 1000"] {
            assert!(rewritten.lines().any(|line| line == metadata));
        }
    }
}
