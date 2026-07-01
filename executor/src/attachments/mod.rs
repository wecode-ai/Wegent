// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod handler;
mod multimodal_prompt;
mod prompt_processor;

pub use handler::{
    download_attachments_with, AttachmentDownloadClient, AttachmentDownloadResult,
    AttachmentDownloaderConfig, AttachmentProcessResult, AttachmentTask,
};
pub use multimodal_prompt::{
    append_text_to_vision_prompt, convert_openai_to_anthropic_content,
    convert_openai_to_anthropic_content_async, create_multimodal_query, is_vision_prompt,
    parse_data_uri, save_vision_images, save_vision_images_to,
};
pub use prompt_processor::{process_prompt, AttachmentPromptProcessor, AttachmentRecord};
