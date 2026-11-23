// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Extract text and prepare model inputs from uploaded attachment bytes.

#![deny(unsafe_code)]

mod csv;
pub mod document;
mod jpeg_metadata;
mod model_image;
mod model_jpeg;
mod office;
mod pdf;
mod resample;
mod truncation;
