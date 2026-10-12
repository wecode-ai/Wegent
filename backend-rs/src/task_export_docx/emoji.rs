// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Emoji classification matching `python-emoji`'s `EMOJI_DATA`.
//!
//! `docx_generator._add_text_with_emoji_support` splits a run at emoji
//! boundaries by testing `char in emoji.EMOJI_DATA` one character at a time,
//! giving each emoji segment its own run with the `Segoe UI Emoji` font.
//! `EMOJI_RANGES` is exactly the set of code points that `emoji==2.15.0`
//! exposes as single-character `EMOJI_DATA` keys, collapsed into sorted,
//! non-overlapping inclusive ranges.

/// Inclusive `(first, last)` code point ranges for single-character
/// `emoji.EMOJI_DATA` keys (`emoji==2.15.0`, 1400 code points).
const EMOJI_RANGES: &[(u32, u32)] = &[
    (0x00A9, 0x00A9),
    (0x00AE, 0x00AE),
    (0x203C, 0x203C),
    (0x2049, 0x2049),
    (0x2122, 0x2122),
    (0x2139, 0x2139),
    (0x2194, 0x2199),
    (0x21A9, 0x21AA),
    (0x231A, 0x231B),
    (0x2328, 0x2328),
    (0x23CF, 0x23CF),
    (0x23E9, 0x23F3),
    (0x23F8, 0x23FA),
    (0x24C2, 0x24C2),
    (0x25AA, 0x25AB),
    (0x25B6, 0x25B6),
    (0x25C0, 0x25C0),
    (0x25FB, 0x25FE),
    (0x2600, 0x2604),
    (0x260E, 0x260E),
    (0x2611, 0x2611),
    (0x2614, 0x2615),
    (0x2618, 0x2618),
    (0x261D, 0x261D),
    (0x2620, 0x2620),
    (0x2622, 0x2623),
    (0x2626, 0x2626),
    (0x262A, 0x262A),
    (0x262E, 0x262F),
    (0x2638, 0x263A),
    (0x2640, 0x2640),
    (0x2642, 0x2642),
    (0x2648, 0x2653),
    (0x265F, 0x2660),
    (0x2663, 0x2663),
    (0x2665, 0x2666),
    (0x2668, 0x2668),
    (0x267B, 0x267B),
    (0x267E, 0x267F),
    (0x2692, 0x2697),
    (0x2699, 0x2699),
    (0x269B, 0x269C),
    (0x26A0, 0x26A1),
    (0x26A7, 0x26A7),
    (0x26AA, 0x26AB),
    (0x26B0, 0x26B1),
    (0x26BD, 0x26BE),
    (0x26C4, 0x26C5),
    (0x26C8, 0x26C8),
    (0x26CE, 0x26CF),
    (0x26D1, 0x26D1),
    (0x26D3, 0x26D4),
    (0x26E9, 0x26EA),
    (0x26F0, 0x26F5),
    (0x26F7, 0x26FA),
    (0x26FD, 0x26FD),
    (0x2702, 0x2702),
    (0x2705, 0x2705),
    (0x2708, 0x270D),
    (0x270F, 0x270F),
    (0x2712, 0x2712),
    (0x2714, 0x2714),
    (0x2716, 0x2716),
    (0x271D, 0x271D),
    (0x2721, 0x2721),
    (0x2728, 0x2728),
    (0x2733, 0x2734),
    (0x2744, 0x2744),
    (0x2747, 0x2747),
    (0x274C, 0x274C),
    (0x274E, 0x274E),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2763, 0x2764),
    (0x2795, 0x2797),
    (0x27A1, 0x27A1),
    (0x27B0, 0x27B0),
    (0x27BF, 0x27BF),
    (0x2934, 0x2935),
    (0x2B05, 0x2B07),
    (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50),
    (0x2B55, 0x2B55),
    (0x3030, 0x3030),
    (0x303D, 0x303D),
    (0x3297, 0x3297),
    (0x3299, 0x3299),
    (0x1F004, 0x1F004),
    (0x1F0CF, 0x1F0CF),
    (0x1F170, 0x1F171),
    (0x1F17E, 0x1F17F),
    (0x1F18E, 0x1F18E),
    (0x1F191, 0x1F19A),
    (0x1F201, 0x1F202),
    (0x1F21A, 0x1F21A),
    (0x1F22F, 0x1F22F),
    (0x1F232, 0x1F23A),
    (0x1F250, 0x1F251),
    (0x1F300, 0x1F321),
    (0x1F324, 0x1F393),
    (0x1F396, 0x1F397),
    (0x1F399, 0x1F39B),
    (0x1F39E, 0x1F3F0),
    (0x1F3F3, 0x1F3F5),
    (0x1F3F7, 0x1F4FD),
    (0x1F4FF, 0x1F53D),
    (0x1F549, 0x1F54E),
    (0x1F550, 0x1F567),
    (0x1F56F, 0x1F570),
    (0x1F573, 0x1F57A),
    (0x1F587, 0x1F587),
    (0x1F58A, 0x1F58D),
    (0x1F590, 0x1F590),
    (0x1F595, 0x1F596),
    (0x1F5A4, 0x1F5A5),
    (0x1F5A8, 0x1F5A8),
    (0x1F5B1, 0x1F5B2),
    (0x1F5BC, 0x1F5BC),
    (0x1F5C2, 0x1F5C4),
    (0x1F5D1, 0x1F5D3),
    (0x1F5DC, 0x1F5DE),
    (0x1F5E1, 0x1F5E1),
    (0x1F5E3, 0x1F5E3),
    (0x1F5E8, 0x1F5E8),
    (0x1F5EF, 0x1F5EF),
    (0x1F5F3, 0x1F5F3),
    (0x1F5FA, 0x1F64F),
    (0x1F680, 0x1F6C5),
    (0x1F6CB, 0x1F6D2),
    (0x1F6D5, 0x1F6D8),
    (0x1F6DC, 0x1F6E5),
    (0x1F6E9, 0x1F6E9),
    (0x1F6EB, 0x1F6EC),
    (0x1F6F0, 0x1F6F0),
    (0x1F6F3, 0x1F6FC),
    (0x1F7E0, 0x1F7EB),
    (0x1F7F0, 0x1F7F0),
    (0x1F90C, 0x1F93A),
    (0x1F93C, 0x1F945),
    (0x1F947, 0x1F9FF),
    (0x1FA70, 0x1FA7C),
    (0x1FA80, 0x1FA8A),
    (0x1FA8E, 0x1FAC6),
    (0x1FAC8, 0x1FAC8),
    (0x1FACD, 0x1FADC),
    (0x1FADF, 0x1FAEA),
    (0x1FAEF, 0x1FAF8),
];

/// `char in emoji.EMOJI_DATA` for a string of one character.
pub(crate) fn is_emoji(c: char) -> bool {
    let cp = c as u32;
    EMOJI_RANGES
        .binary_search_by(|&(first, last)| {
            if cp < first {
                std::cmp::Ordering::Greater
            } else if cp > last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Split `text` into `(is_emoji, segment)` pieces the way
/// `_add_text_with_emoji_support` walks its input: consecutive characters of
/// the same kind stay together, and empty input yields no segments.
pub(crate) fn split_by_emoji(text: &str) -> Vec<(bool, &str)> {
    let mut segments = Vec::new();
    if text.is_empty() {
        return segments;
    }
    let mut start = 0usize;
    let mut current_is_emoji = false;
    for (idx, ch) in text.char_indices() {
        let ch_is_emoji = is_emoji(ch);
        if idx == 0 {
            current_is_emoji = ch_is_emoji;
        } else if ch_is_emoji != current_is_emoji {
            segments.push((current_is_emoji, &text[start..idx]));
            start = idx;
            current_is_emoji = ch_is_emoji;
        }
    }
    segments.push((current_is_emoji, &text[start..]));
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_emoji_and_non_emoji_code_points() {
        assert!(is_emoji('👋'));
        assert!(is_emoji('😀'));
        assert!(is_emoji('❤'));
        assert!(is_emoji('⚠'));
        // Variation selector and joiner are not single-character keys.
        assert!(!is_emoji('\u{FE0F}'));
        assert!(!is_emoji('\u{200D}'));
        assert!(!is_emoji('A'));
        assert!(!is_emoji('汉'));
        assert!(!is_emoji(' '));
    }

    #[test]
    fn splits_like_the_source_helper() {
        assert_eq!(split_by_emoji(""), Vec::<(bool, &str)>::new());
        assert_eq!(
            split_by_emoji("Hello! 👋"),
            vec![(false, "Hello! "), (true, "👋")]
        );
        assert_eq!(split_by_emoji("😀ab"), vec![(true, "😀"), (false, "ab")]);
        assert_eq!(split_by_emoji("😀😀"), vec![(true, "😀😀")]);
        assert_eq!(split_by_emoji("plain"), vec![(false, "plain")]);
        // A zero-width joiner is not an emoji key, so it stays with the
        // surrounding non-emoji text exactly like the Python loop.
        assert_eq!(
            split_by_emoji("👨\u{200D}👩"),
            vec![(true, "👨"), (false, "\u{200D}"), (true, "👩")]
        );
    }
}
