// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/bots` — the current user's Bot list with scope support
//! (`app.api.endpoints.adapter.bots.list_bots`).
//!
//! The endpoint mirrors the source pipeline: bearer-session authentication,
//! scope-driven namespace resolution (`get_user_groups` for `group`/`all`),
//! the paginated `kinds` Bot lookup, a batched preload of the referenced
//! Ghost/Shell/Model `kinds`, and the per-bot `_convert_to_bot_dict`
//! projection.
//!
//! Statements reproduce the source SQLAlchemy ORM rendering exactly (full
//! column lists with `table_column` aliases, predicate order, and value
//! binding) because the replay engine matches MySQL exchanges by normalized
//! SQL token stream; a different projection or alias set is an unmatched
//! dependency. Literal lists derived from Python sets are emitted in
//! first-seen order because the source iteration order is hash-seed
//! dependent.

pub mod conversion;
pub mod handler;
pub mod repository;
