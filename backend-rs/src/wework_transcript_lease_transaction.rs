// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Writer transactions for the Wework transcript lease APIs.
//!
//! `app.services.wework_transcript_service` runs every lease mutation in the
//! request-scoped SQLAlchemy session: `get_transcript(..., for_update=True)`
//! takes the row lock, the dirty flush updates the row, and `db.commit()` ends
//! the transaction, while a `WeworkTranscriptError` leaves the session to
//! `db.rollback()`. `brz-mysql` only accepts `FOR UPDATE` through
//! `Mysql::with_transaction` (`read-query-check` rejects a pool-level locking
//! read before it reaches MySQL), so the locking read and its write must stay
//! on one transaction connection.
//!
//! `Mysql::with_transaction` commits on `Ok` and rolls back on `Err`, so a lease
//! rejection is carried out of the closure through
//! [`crate::transaction_outcome::Completion`], the same helper the other
//! source sessions with a non-database outcome use.

pub(crate) use crate::transaction_outcome::{Completion, run};
