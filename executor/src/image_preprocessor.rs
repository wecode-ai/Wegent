// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::Cursor;

use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};

pub const MAX_MODEL_IMAGE_LONG_EDGE: u32 = 1568;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedModelImage {
    pub data: Vec<u8>,
    pub mime_type: String,
    pub original_size: Option<(u32, u32)>,
    pub size: Option<(u32, u32)>,
    pub resized: bool,
}

pub fn prepare_image_bytes_for_model(
    image_data: &[u8],
    mime_type: &str,
    max_long_edge: Option<u32>,
) -> PreparedModelImage {
    if image_data.is_empty() {
        return unchanged(image_data, mime_type);
    }

    let input_mime = coerce_mime_type(mime_type);
    let Some(output_format) = output_format(&input_mime) else {
        return unchanged(image_data, &input_mime);
    };

    let Ok(mut image) = decode_image(image_data) else {
        return unchanged(image_data, &input_mime);
    };
    let original_size = image.dimensions();
    let max_long_edge = max_long_edge.unwrap_or(MAX_MODEL_IMAGE_LONG_EDGE);
    let needs_resize = original_size.0.max(original_size.1) > max_long_edge;
    let output_mime = output_mime(&input_mime, output_format);
    let needs_convert = output_mime != input_mime;

    if !needs_resize && !needs_convert {
        return PreparedModelImage {
            data: image_data.to_vec(),
            mime_type: input_mime,
            original_size: Some(original_size),
            size: Some(original_size),
            resized: false,
        };
    }

    if needs_resize {
        image = image.thumbnail(max_long_edge, max_long_edge);
    }

    let final_format = if input_mime == "image/gif" && needs_resize {
        ImageFormat::Png
    } else {
        output_format
    };
    let final_mime = mime_for_format(final_format);
    let Ok(data) = encode_image(&image, final_format) else {
        return unchanged(image_data, &input_mime);
    };

    PreparedModelImage {
        data,
        mime_type: final_mime.to_owned(),
        original_size: Some(original_size),
        size: Some(image.dimensions()),
        resized: true,
    }
}

fn decode_image(image_data: &[u8]) -> image::ImageResult<DynamicImage> {
    ImageReader::new(Cursor::new(image_data))
        .with_guessed_format()?
        .decode()
}

fn encode_image(image: &DynamicImage, format: ImageFormat) -> image::ImageResult<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, format)?;
    Ok(output.into_inner())
}

fn unchanged(image_data: &[u8], mime_type: &str) -> PreparedModelImage {
    PreparedModelImage {
        data: image_data.to_vec(),
        mime_type: coerce_mime_type(mime_type),
        original_size: None,
        size: None,
        resized: false,
    }
}

fn coerce_mime_type(mime_type: &str) -> String {
    if mime_type.trim().is_empty() {
        "image/png".to_owned()
    } else {
        mime_type.trim().to_ascii_lowercase()
    }
}

fn output_format(mime_type: &str) -> Option<ImageFormat> {
    match mime_type {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/gif" => Some(ImageFormat::Gif),
        "image/webp" => Some(ImageFormat::WebP),
        "image/bmp" => Some(ImageFormat::Png),
        _ => None,
    }
}

fn output_mime(input_mime: &str, output_format: ImageFormat) -> String {
    if input_mime == "image/jpg" {
        return "image/jpeg".to_owned();
    }
    mime_for_format(output_format).to_owned()
}

fn mime_for_format(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Bmp => "image/bmp",
        _ => "image/png",
    }
}
