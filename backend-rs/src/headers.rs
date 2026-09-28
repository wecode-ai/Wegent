// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Header accessor used by inline authentication.
//!
//! `http-server` binds declared headers as `Option<&str>` and business
//! handlers pass those borrowed values here; the trait keeps the existing
//! per-module auth functions testable with plain maps.
use std::collections::HashMap;

/// Read-only view of the request headers an auth function needs.
pub trait Headers {
    /// First value of `name`, case-insensitive.
    fn header(&self, name: &str) -> Option<&str>;
}

impl Headers for HashMap<String, String> {
    fn header(&self, name: &str) -> Option<&str> {
        self.get(name).map(String::as_str)
    }
}

/// A borrowed slice of already-extracted header values (name, value).
#[cfg(test)]
pub struct HeaderSlice<'a> {
    entries: &'a [(&'a str, &'a str)],
}

#[cfg(test)]
impl<'a> HeaderSlice<'a> {
    #[must_use]
    pub fn new(entries: &'a [(&'a str, &'a str)]) -> Self {
        Self { entries }
    }
}

/// One owned header entry for constructing a [`HeaderSlice`] from values
/// that live in a local binding (for example a handler's bound headers).
#[derive(Debug)]
pub struct OwnedHeaders {
    entries: Vec<(String, String)>,
}

impl OwnedHeaders {
    #[must_use]
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Builds a view from an iterator of optional header pairs; `None`
    /// values are skipped.
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) -> Self {
        let mut headers = Self::new();
        for (name, value) in pairs {
            if let Some(value) = value {
                headers.push(name, value);
            }
        }
        headers
    }

    /// Appends one header (name, value).
    pub fn push(&mut self, name: &str, value: &str) {
        self.entries.push((name.to_string(), value.to_string()));
    }

    /// Returns a borrowable view usable as `&impl Headers`.
    pub fn view(&self) -> HeaderView<'_> {
        HeaderView { inner: self }
    }
}

impl Default for OwnedHeaders {
    fn default() -> Self {
        Self::new()
    }
}

/// Borrowed view over [`OwnedHeaders`].
pub struct HeaderView<'a> {
    inner: &'a OwnedHeaders,
}

impl Headers for HeaderView<'_> {
    fn header(&self, name: &str) -> Option<&str> {
        self.inner
            .entries
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[cfg(test)]
impl Headers for HeaderSlice<'_> {
    fn header(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| *value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_case_insensitive_header() {
        let map = HeaderSlice::new(&[("Authorization", "Bearer abc")]);
        assert_eq!(map.header("authorization"), Some("Bearer abc"));
        assert_eq!(map.header("authorization"), Some("Bearer abc"));
        assert_eq!(map.header("x-missing"), None);
    }
}
