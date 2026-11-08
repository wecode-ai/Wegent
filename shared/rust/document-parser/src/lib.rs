// SPDX-License-Identifier: Apache-2.0
//! Shared native document parsers for Backend and local attachment consumers.
#![forbid(unsafe_code)]

mod control;
pub mod office;
pub mod pdf;
pub use control::ParseControl;
