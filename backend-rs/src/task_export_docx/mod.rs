// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/export/docx` — export a task conversation to a
//! DOCX file (`app.api.endpoints.adapter.tasks.export_task_docx` ->
//! `app.services.export.docx_generator.generate_task_docx`).
//!
//! The route authenticates through a short-lived `download_token` JWT
//! (`app.services.auth.docx_export_download_token`) or the optional bearer
//! session, re-checks task membership, loads the task, filtered subtasks,
//! attachment contexts, and sender names, then renders a DOCX package that
//! reproduces the python-docx 1.2.0 `Document()` serialization byte-for-byte
//! (template parts, XML forms, and zip framing) except for the two
//! current-time values the source also embeds (zip entry timestamps and
//! `docProps/core.xml` `dcterms:created`).

pub mod generator;
mod markdown;
mod package;
mod repository;
mod router;

pub use generator::test_support;
mod token;
pub mod xml;
