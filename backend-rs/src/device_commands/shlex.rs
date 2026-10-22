// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `shlex.split(value)` with `comments=False` and `posix=True`.
//!
//! The source builds the executor argv with `shlex.split`, so quoting inside a
//! configured command must be decoded exactly like CPython's `shlex`. This is
//! the POSIX state machine from `Lib/shlex.py::shlex.read_token` restricted to
//! `whitespace_split=True` and no commenters.

/// A `ValueError` from `shlex.split` (`No closing quotation` / `No escaped
/// character`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShlexError(&'static str);

impl std::fmt::Display for ShlexError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for ShlexError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// `' '`: between tokens.
    Space,
    /// `'a'`: inside a bare word.
    Word,
    /// Inside a single or double quote.
    Quote(char),
    /// After a backslash.
    Escape,
}

/// `shlex.split(value)`.
pub(crate) fn split(value: &str) -> Result<Vec<String>, ShlexError> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut state = State::Space;
    let mut escaped_state = State::Word;
    let mut quoted = false;

    for character in value.chars() {
        match state {
            State::Space => {
                if is_whitespace(character) {
                    if !token.is_empty() || quoted {
                        emit(&mut tokens, &mut token, &mut quoted);
                    }
                } else if character == '\\' {
                    escaped_state = State::Word;
                    state = State::Escape;
                } else if is_quote(character) {
                    state = State::Quote(character);
                } else {
                    token.push(character);
                    state = State::Word;
                }
            }
            State::Word => {
                if is_whitespace(character) {
                    state = State::Space;
                    if !token.is_empty() || quoted {
                        emit(&mut tokens, &mut token, &mut quoted);
                    }
                } else if is_quote(character) {
                    state = State::Quote(character);
                } else if character == '\\' {
                    escaped_state = State::Word;
                    state = State::Escape;
                } else {
                    token.push(character);
                }
            }
            State::Quote(quote) => {
                quoted = true;
                if character == quote {
                    state = State::Word;
                } else if character == '\\' && quote == '"' {
                    escaped_state = State::Quote(quote);
                    state = State::Escape;
                } else {
                    token.push(character);
                }
            }
            State::Escape => {
                // Inside quotes, only the quote itself and the escape
                // character may be escaped; every other pair keeps the
                // backslash.
                if let State::Quote(quote) = escaped_state
                    && character != '\\'
                    && character != quote
                {
                    token.push('\\');
                }
                token.push(character);
                state = escaped_state;
            }
        }
    }

    match state {
        State::Quote(_) => return Err(ShlexError("No closing quotation")),
        State::Escape => return Err(ShlexError("No escaped character")),
        State::Space | State::Word => {}
    }
    if !token.is_empty() || quoted {
        emit(&mut tokens, &mut token, &mut quoted);
    }
    Ok(tokens)
}

fn emit(tokens: &mut Vec<String>, token: &mut String, quoted: &mut bool) {
    tokens.push(std::mem::take(token));
    *quoted = false;
}

fn is_whitespace(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\r' | '\n')
}

fn is_quote(character: char) -> bool {
    matches!(character, '\'' | '"')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_ok(value: &str) -> Vec<String> {
        split(value).expect("value splits")
    }

    #[test]
    fn plain_words_and_whitespace() {
        assert_eq!(split_ok("pwd"), ["pwd"]);
        assert_eq!(split_ok("  ls   -a\t-p\n"), ["ls", "-a", "-p"]);
    }

    #[test]
    fn single_and_double_quotes_group_an_argument() {
        assert_eq!(split_ok("sh -c 'a b'"), ["sh", "-c", "a b"]);
        assert_eq!(split_ok(r#"sh -c "a b""#), ["sh", "-c", "a b"]);
        assert_eq!(split_ok("a '' b"), ["a", "", "b"]);
        assert_eq!(split_ok("a''b"), ["ab"]);
    }

    #[test]
    fn shell_quote_trick_round_trips_a_single_quote() {
        // The registry's embedded scripts escape `'` as `'"'"'`.
        assert_eq!(
            split_ok(r#"python3 -c 'a'"'"'b'"#),
            ["python3", "-c", "a'b"]
        );
    }

    #[test]
    fn escapes_follow_the_posix_rules() {
        assert_eq!(split_ok(r"a\ b"), ["a b"]);
        assert_eq!(split_ok(r#""a\"b""#), [r#"a"b"#]);
        assert_eq!(split_ok(r#""a\zb""#), [r"a\zb"]);
        assert_eq!(split_ok(r"a\\b"), [r"a\b"]);
    }

    #[test]
    fn unbalanced_quotes_are_errors() {
        assert_eq!(split("'abc"), Err(ShlexError("No closing quotation")));
        assert_eq!(split("a\\"), Err(ShlexError("No escaped character")));
    }
}
