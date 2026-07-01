// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::Cursor;

use image::{
    codecs::gif::{GifEncoder, Repeat},
    DynamicImage, Frame, ImageBuffer, ImageFormat, Rgb, Rgba,
};
use wegent_executor::image_preprocessor::prepare_image_bytes_for_model;

fn image_bytes(format: ImageFormat, size: (u32, u32)) -> Vec<u8> {
    let image = ImageBuffer::from_pixel(size.0, size.1, Rgb([32, 144, 208]));
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut output, format)
        .unwrap();
    output.into_inner()
}

fn animated_gif_bytes(size: (u32, u32)) -> Vec<u8> {
    let mut output = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut output);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        encoder
            .encode_frame(Frame::new(ImageBuffer::from_pixel(
                size.0,
                size.1,
                Rgba([32, 144, 208, 255]),
            )))
            .unwrap();
        encoder
            .encode_frame(Frame::new(ImageBuffer::from_pixel(
                size.0,
                size.1,
                Rgba([208, 96, 32, 255]),
            )))
            .unwrap();
    }
    output
}

fn png_dimensions(data: &[u8]) -> (u32, u32) {
    assert!(data.starts_with(b"\x89PNG\r\n\x1a\n"));
    let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
    (width, height)
}

#[test]
fn bmp_within_limit_is_converted_to_png() {
    let prepared =
        prepare_image_bytes_for_model(&image_bytes(ImageFormat::Bmp, (16, 8)), "image/bmp", None);

    assert_eq!(prepared.mime_type, "image/png");
    assert!(prepared.data.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert_eq!(prepared.original_size, Some((16, 8)));
    assert_eq!(prepared.size, Some((16, 8)));
    assert!(prepared.resized);
}

#[test]
fn animated_gif_resize_outputs_first_frame_as_png() {
    let prepared =
        prepare_image_bytes_for_model(&animated_gif_bytes((256, 128)), "image/gif", Some(128));

    assert_eq!(prepared.mime_type, "image/png");
    assert_eq!(png_dimensions(&prepared.data), (128, 64));
    assert!(prepared.resized);
}
