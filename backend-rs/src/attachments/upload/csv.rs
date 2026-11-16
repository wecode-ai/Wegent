// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Python-compatible CSV parsing, dense row formatting, and head/tail truncation.
use std::io::Read;

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{BIG5, Encoding, GB18030, GBK, WINDOWS_1252};

use super::truncation::Truncated;

const FIELD_LIMIT: usize = 131_072;
const MAX_COLUMNS: usize = 50;
const SHEET_HEADER: &str = "--- Sheet: CSV Data ---";

pub(super) fn parse(bytes: &[u8]) -> Result<Vec<Vec<String>>, String> {
    let text = decode(bytes);
    // Python tries UTF-8 first and retains its BOM as cell data. An ignored
    // initial blank record prevents csv's automatic BOM removal.
    let input = b"\n".as_slice().chain(text.as_bytes());
    let mut reader = ::csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(input);
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|error| error.to_string())?;
        if record
            .iter()
            .any(|field| field.chars().count() > FIELD_LIMIT)
        {
            return Err(format!("field larger than field limit ({FIELD_LIMIT})"));
        }
        let row: Vec<String> = record
            .iter()
            .map(|cell| {
                cell.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
                    .to_owned()
            })
            .collect();
        if row.iter().any(|cell| !cell.is_empty()) {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn decode(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    if let Some((encoding, bom_length)) = Encoding::for_bom(bytes)
        && let Some(text) =
            encoding.decode_without_bom_handling_and_without_replacement(&bytes[bom_length..])
    {
        return text.into_owned();
    }
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let guessed = detector.guess(None, Utf8Detection::Deny);
    // Match Python's UTF-8 priority and Chinese-encoding preference. GB18030
    // also handles four-byte characters that a GBK detector cannot identify.
    let guessed = if guessed == GBK { GB18030 } else { guessed };
    for encoding in [guessed, GB18030, GBK, BIG5] {
        if encoding == WINDOWS_1252 {
            continue;
        }
        if let Some(text) = encoding.decode_without_bom_handling_and_without_replacement(bytes) {
            return text.into_owned();
        }
    }
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

fn format_row(row: &[String]) -> String {
    let mut formatted = row
        .iter()
        .take(MAX_COLUMNS)
        .cloned()
        .collect::<Vec<_>>()
        .join(" | ");
    if row.len() > MAX_COLUMNS {
        formatted.push_str(&format!(" | ... (+{} columns)", row.len() - MAX_COLUMNS));
    }
    formatted
}

pub(super) fn truncate(rows: &[Vec<String>], max_length: usize) -> Truncated {
    let formatted: Vec<String> = rows.iter().map(|row| format_row(row)).collect();
    let full = if formatted.is_empty() {
        String::new()
    } else {
        format!("{SHEET_HEADER}\n{}", formatted.join("\n"))
    };
    let original_length = full.chars().count();
    if original_length <= max_length {
        return outcome(full, original_length, false);
    }

    let average = original_length as f64 / rows.len().max(1) as f64;
    let kept = (((max_length as f64 - 300.0) / average) as usize).max(5);
    let data_kept = kept - 1;
    if data_kept >= rows.len() - 1 {
        return outcome(
            cut_at_row_boundary(&full, max_length),
            original_length,
            true,
        );
    }

    let tail_count = (data_kept / 2).max(1);
    let head_count = data_kept - tail_count;
    let mut parts = vec![
        SHEET_HEADER.to_owned(),
        "# Header".to_owned(),
        formatted[0].clone(),
    ];
    parts.push(format!("\n# Head Data (rows 2-{})", head_count + 1));
    parts.extend_from_slice(&formatted[1..1 + head_count]);
    let omitted = rows.len() - 1 - head_count - tail_count;
    if omitted > 0 {
        parts.push(format!("\n... [{omitted} rows omitted] ..."));
    }
    parts.push(format!(
        "\n# Tail Data (rows {}-{})",
        rows.len() - tail_count + 1,
        rows.len()
    ));
    parts.extend_from_slice(&formatted[rows.len() - tail_count..]);
    let mut text = parts.join("\n");
    if text.chars().count() > max_length {
        text = cut_at_row_boundary(&text, max_length);
    }
    outcome(text, original_length, true)
}

fn cut_at_row_boundary(text: &str, max_length: usize) -> String {
    let marker = "\n... [truncated] ...";
    let budget = max_length.saturating_sub(marker.chars().count());
    let mut prefix: String = text.chars().take(budget).collect();
    if let Some(boundary) = prefix.rfind('\n').filter(|index| *index > 0) {
        prefix.truncate(boundary);
    }
    prefix + marker
}

fn outcome(text: String, original_length: usize, is_truncated: bool) -> Truncated {
    Truncated {
        truncated_length: text.chars().count(),
        text,
        original_length,
        is_truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden cases come from Python csv.reader and CSVTruncationStrategy.
    #[test]
    fn csv_matches_python_formatting_and_truncation_fixtures() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("csv_python_fixtures.json")).unwrap();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let rows = parse(case["input"].as_str().unwrap().as_bytes()).unwrap();
            let actual = truncate(&rows, case["max_length"].as_u64().unwrap() as usize);
            assert_eq!(actual.text, case["text"].as_str().unwrap(), "{name}");
            assert_eq!(
                actual.is_truncated,
                case["is_truncated"].as_bool().unwrap(),
                "{name}"
            );
            assert_eq!(
                actual.original_length,
                case["original_length"].as_u64().unwrap() as usize,
                "{name}"
            );
            assert_eq!(
                actual.truncated_length,
                case["truncated_length"].as_u64().unwrap() as usize,
                "{name}"
            );
        }
    }

    #[test]
    fn quoted_multiline_ragged_and_blank_rows_match_python() {
        let rows = parse(b"name,value\r\n\"a,b\",\"first\r\nsecond\"\r\n\"say \"\"hi\"\"\", 42 \r\n,,\r\nlast\r\n").unwrap();
        assert_eq!(
            rows,
            [
                vec!["name", "value"],
                vec!["a,b", "first\r\nsecond"],
                vec!["say \"hi\"", "42"],
                vec!["last"],
            ]
        );
        let parsed = truncate(&rows, 500_000);
        assert_eq!(
            parsed.text,
            "--- Sheet: CSV Data ---\nname | value\na,b | first\r\nsecond\nsay \"hi\" | 42\nlast"
        );
        assert!(!parsed.is_truncated);
    }

    #[test]
    fn chinese_encodings_and_utf8_bom_keep_cell_contents() {
        let source = "名称,数量\n中文测试,42\n这是用于验证中文编码的测试数据,100\n";
        for encoding in [GB18030, GBK] {
            let (encoded, _, errors) = encoding.encode(source);
            assert!(!errors);
            assert_eq!(parse(&encoded).unwrap()[1], ["中文测试", "42"]);
        }
        let traditional = "名稱,數量\n這是一筆繁體中文編碼測試資料,42\n";
        let (encoded, _, errors) = BIG5.encode(traditional);
        assert!(!errors);
        assert_eq!(
            parse(&encoded).unwrap()[1],
            ["這是一筆繁體中文編碼測試資料", "42"]
        );
        assert_eq!(
            parse("\u{feff}name,value\n".as_bytes()).unwrap()[0][0],
            "\u{feff}name"
        );
    }

    #[test]
    fn field_limit_and_empty_rows_keep_the_source_contract() {
        assert!(
            parse("a".repeat(FIELD_LIMIT + 1).as_bytes())
                .unwrap_err()
                .contains("field larger")
        );
        for bytes in [b"".as_slice(), b" \t, \r\n,,\n"] {
            assert_eq!(truncate(&parse(bytes).unwrap(), 500_000).text, "");
        }
    }

    #[test]
    fn wide_rows_are_formatted_with_the_python_column_marker() {
        let row: Vec<String> = (0..52).map(|i| i.to_string()).collect();
        let result = truncate(&[row], 500_000);
        assert!(result.text.ends_with("48 | 49 | ... (+2 columns)"));
    }

    #[test]
    fn truncation_preserves_header_and_contiguous_head_and_tail() {
        let rows: Vec<Vec<String>> = (0..40)
            .map(|i| vec![format!("row{i}"), "value".to_owned()])
            .collect();
        let result = truncate(&rows, 350);
        assert_eq!(
            result.text,
            "--- Sheet: CSV Data ---\n# Header\nrow0 | value\n\n# Head Data (rows 2-3)\nrow1 | value\nrow2 | value\n\n... [35 rows omitted] ...\n\n# Tail Data (rows 39-40)\nrow38 | value\nrow39 | value"
        );
        assert_eq!(
            result.original_length,
            truncate(&rows, 500_000).text.chars().count()
        );
        assert_eq!(result.truncated_length, result.text.chars().count());
        assert!(result.is_truncated);
    }
}
