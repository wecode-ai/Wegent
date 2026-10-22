// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The Office document parsers `POST /api/attachments/upload` needs.
//!
//! `app/services/attachment/parser.py` delegates each special format to a
//! Python library: `python-docx` for Word, `openpyxl` (through
//! `knowledge_engine.excel`) for spreadsheets. Both read an OOXML package, so
//! this module owns the container reader ([`zip`]), the part scanner
//! ([`xml`]) and the two extractors ([`word`], [`excel`]); formatting rules
//! that come from CPython rather than the format live in
//! [`excel_serial`].
//!
//! A file that cannot be opened or read is a `DocumentParseError` in the
//! source (`parse_failed`); the extractors report that as [`OfficeError`].
pub(crate) mod excel;
mod excel_formula;
pub(crate) mod excel_serial;
pub(crate) mod powerpoint;
pub(crate) mod word;
pub(crate) mod xml;
pub(crate) mod zip;

/// A package the source's document library would refuse to parse.
#[derive(Debug)]
pub(crate) struct OfficeError;
