// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Pillow-compatible JPEG validation, thumbnailing, and optimized encoding.

use base64::Engine as _;
use turbojpeg::{Colorspace, Compressor, Decompressor, Image, PixelFormat, Subsamp};

use super::model_image::{
    MAX_IMAGE_PIXELS, MAX_MODEL_IMAGE_LONG_EDGE, decode_png, premultiply, unpremultiply,
};
use super::resample::{reduce, resample, resample_box, thumbnail_size};

/// `thumbnail(..., reducing_gap=3.0)`: the integer pre-reduce factors
/// `resize` applies before the Lanczos pass (`int(box / size / gap) or 1`).
fn reducing_factors(width: usize, height: usize, target: (usize, usize)) -> (usize, usize) {
    let factor_x = (width / target.0 / 3).max(1);
    let factor_y = (height / target.1 / 3).max(1);
    (factor_x, factor_y)
}

/// `_get_safe_box`: expand the box by the LancZOS support (2.5) scaled by
/// the per-axis reduction ratio, clamped to the image.
fn safe_box(
    width: usize,
    height: usize,
    target: (usize, usize),
) -> ((usize, usize), (usize, usize)) {
    const FILTER_SUPPORT: f64 = 3.0 - 0.5;
    let support_x = FILTER_SUPPORT * (width as f64 / target.0 as f64);
    let support_y = FILTER_SUPPORT * (height as f64 / target.1 as f64);
    (
        (
            (0.0 - support_x).max(0.0) as usize,
            (0.0 - support_y).max(0.0) as usize,
        ),
        (
            (width as f64 + support_x).ceil().min(width as f64) as usize,
            (height as f64 + support_y).ceil().min(height as f64) as usize,
        ),
    )
}

pub(super) struct PreparedJpeg {
    pub width: u32,
    pub height: u32,
    pub format: &'static str,
    pub mode: &'static str,
    pub has_exif: bool,
    pub image_base64: String,
}

pub(super) fn prepare(bytes: &[u8]) -> Option<PreparedJpeg> {
    let mut decoder = Decompressor::new().ok()?;
    let header = decoder.read_header(bytes).ok()?;
    let width = u32::try_from(header.width).ok()?;
    let height = u32::try_from(header.height).ok()?;
    if u64::from(width) * u64::from(height) > 2 * MAX_IMAGE_PIXELS {
        return None;
    }
    let (format, channels, mode) = match header.colorspace {
        Colorspace::Gray => (PixelFormat::GRAY, 1, "L"),
        Colorspace::CMYK | Colorspace::YCCK => (PixelFormat::CMYK, 4, "CMYK"),
        _ => (PixelFormat::RGB, 3, "RGB"),
    };
    let pitch = header.width.checked_mul(channels)?;
    let mut pixels = vec![0u8; pitch.checked_mul(header.height)?];
    let decoded = decoder.decompress(
        bytes,
        Image {
            pixels: pixels.as_mut_slice(),
            width: header.width,
            height: header.height,
            pitch,
            format,
        },
    );
    match decoded {
        Ok(()) => {}
        // libjpeg completes the output for JWRN_HIT_MARKER, filling missing
        // entropy bits as Pillow does. The pinned wrapper reports this warning
        // as an error even after decoding every scanline. Accept only this
        // precise warning; fatal errors and truncated files still fail.
        Err(turbojpeg::Error::TurboJpegError(message))
            if message == "Corrupt JPEG data: premature end of data segment" => {}
        Err(_) => return None,
    }
    // libjpeg returns Adobe-inverted CMYK; Pillow exposes non-inverted CMYK
    // before resizing, so normalize before the fixed-point convolution.
    if channels == 4 {
        for value in &mut pixels {
            *value = 255 - *value;
        }
    }
    let (width, height, data) = match thumbnail_size(width, height, MAX_MODEL_IMAGE_LONG_EDGE) {
        None => (width, height, bytes.to_vec()),
        Some(target) => {
            let target = (target.0 as usize, target.1 as usize);
            let pixels = resample_with_reducing_gap(
                pixels,
                width as usize,
                height as usize,
                target,
                channels,
            );
            let pixels = rgb_pixels(pixels, channels);
            let data = encode(&pixels, target.0, target.1)?;
            (target.0 as u32, target.1 as u32, data)
        }
    };
    Some(PreparedJpeg {
        width,
        height,
        format: super::jpeg_metadata::format(bytes),
        mode,
        has_exif: has_exif(bytes),
        image_base64: base64::engine::general_purpose::STANDARD.encode(data),
    })
}

/// `prepare_image_bytes_for_model` when Pillow detects PNG content under a
/// `.jpg`/`.jpeg` filename: `Image.open` reads the format from the bytes, while
/// the extension's MIME (`image/jpeg`) still selects JPEG as the output format.
/// The decoded PNG pixels take the same resize path and are encoded as JPEG.
///
/// Returns the base64 payload and the prepared dimensions; `None` dimensions
/// mean the source kept the original bytes (no resize, or an unreadable image).
pub(super) fn prepare_png_as_jpeg(image_data: &[u8]) -> (String, Option<(u32, u32)>) {
    let engine = base64::engine::general_purpose::STANDARD;
    match encode_png_content_as_jpeg(image_data) {
        Some((data, size)) => (engine.encode(&data), Some(size)),
        None => (engine.encode(image_data), None),
    }
}

fn encode_png_content_as_jpeg(image_data: &[u8]) -> Option<(Vec<u8>, (u32, u32))> {
    let decoded = decode_png(image_data)?;
    let (width, height) = (decoded.width, decoded.height);
    let (target_width, target_height) = thumbnail_size(width, height, MAX_MODEL_IMAGE_LONG_EDGE)?;
    let (source_pixels, source_channels) = match decoded.channels {
        4 => (premultiply(&decoded.pixels), 4),
        channels => (decoded.pixels, channels),
    };
    let resized = resample(
        &source_pixels,
        width as usize,
        height as usize,
        target_width as usize,
        target_height as usize,
        source_channels,
    );
    // `_normalize_mode_for_output` for JPEG: `RGBA`/`LA` paste over white and
    // the remaining modes expand to RGB.
    let rgb = match source_channels {
        1 => resized.into_iter().flat_map(|value| [value; 3]).collect(),
        3 => resized,
        4 => composite_over_white(&unpremultiply(&resized)),
        _ => return None,
    };
    let data = encode(&rgb, target_width as usize, target_height as usize)?;
    Some((data, (target_width, target_height)))
}

/// `_normalize_mode_for_output`: `background.paste(image.convert("RGB"),
/// mask=alpha)` over a white `RGB` image.
fn composite_over_white(pixels: &[u8]) -> Vec<u8> {
    pixels
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|pixel| {
            let alpha = u32::from(pixel[3]);
            [0, 1, 2].map(|index| {
                ((u32::from(pixel[index]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
            })
        })
        .collect()
}

/// `resize` with `reducing_gap=3.0` (`Image.py`): when either integer
/// pre-reduce factor exceeds 1, first `reduce` inside the safe box, then
/// Lanczos-resample the reduced image over the box mapped into reduced
/// coordinates. Without a pre-reduce, one plain resample covers the image.
fn resample_with_reducing_gap(
    pixels: Vec<u8>,
    width: usize,
    height: usize,
    target: (usize, usize),
    channels: usize,
) -> Vec<u8> {
    let factors = reducing_factors(width, height, target);
    if factors == (1, 1) {
        return resample(&pixels, width, height, target.0, target.1, channels);
    }
    let ((box_x0, box_y0), (box_x1, box_y1)) = safe_box(width, height, target);
    let reduced = reduce(&pixels, width, height, channels, factors);
    let reduced_width = width.div_ceil(factors.0);
    let reduced_height = height.div_ceil(factors.1);
    // The reduce kept only the safe box's rows/rows; map the box into the
    // reduced image's coordinates. `_get_safe_box` clamps to the image
    // bounds, so the offsets land inside.
    let box_x0 = (box_x0 as f64) / factors.0 as f64;
    let box_y0 = (box_y0 as f64) / factors.1 as f64;
    let box_x1 = (box_x1 as f64) / factors.0 as f64;
    let box_y1 = (box_y1 as f64) / factors.1 as f64;
    resample_box(
        &reduced,
        reduced_width,
        reduced_height,
        target.0,
        target.1,
        channels,
        (box_x0, box_y0, box_x1, box_y1),
    )
}

fn rgb_pixels(pixels: Vec<u8>, channels: usize) -> Vec<u8> {
    match channels {
        1 => pixels.into_iter().flat_map(|value| [value; 3]).collect(),
        4 => pixels
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|pixel| {
                let black = u32::from(255 - pixel[3]);
                [0, 1, 2].map(|index| ((u32::from(255 - pixel[index]) * black + 127) / 255) as u8)
            })
            .collect(),
        _ => pixels,
    }
}

fn encode(pixels: &[u8], width: usize, height: usize) -> Option<Vec<u8>> {
    let mut encoder = Compressor::new().ok()?;
    encoder.set_quality(85).ok()?;
    encoder.set_subsamp(Subsamp::Sub2x2).ok()?;
    encoder.set_optimize(true).ok()?;
    encoder
        .compress_to_vec(Image {
            pixels,
            width,
            height,
            pitch: width * 3,
            format: PixelFormat::RGB,
        })
        .ok()
}

/// Pillow's `_getexif()` is truthy only for a nonempty, valid TIFF directory.
fn has_exif(bytes: &[u8]) -> bool {
    let mut offset = 2;
    while bytes.get(offset) == Some(&0xff) {
        let Some(&marker) = bytes.get(offset + 1) else {
            return false;
        };
        if matches!(marker, 0xda | 0xd9) {
            break;
        }
        if marker == 0xff {
            offset += 1;
            continue;
        }
        let Some(length) = bytes.get(offset + 2..offset + 4) else {
            return false;
        };
        let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
        if length < 2 {
            return false;
        }
        let Some(payload) = bytes.get(offset + 4..offset + 2 + length) else {
            return false;
        };
        if marker == 0xe1
            && let Some(tiff) = payload.strip_prefix(b"Exif\0\0")
            && nonempty_tiff(tiff)
        {
            return true;
        }
        offset += 2 + length;
    }
    false
}

fn nonempty_tiff(tiff: &[u8]) -> bool {
    let Some(header) = tiff.get(..8) else {
        return false;
    };
    let little_endian = match &header[..4] {
        b"II\x2a\0" => true,
        b"MM\0\x2a" => false,
        _ => return false,
    };
    let offset_bytes = [header[4], header[5], header[6], header[7]];
    let offset = if little_endian {
        u32::from_le_bytes(offset_bytes)
    } else {
        u32::from_be_bytes(offset_bytes)
    } as usize;
    let Some(count) = tiff.get(offset..offset + 2) else {
        return false;
    };
    let count = if little_endian {
        u16::from_le_bytes([count[0], count[1]])
    } else {
        u16::from_be_bytes([count[0], count[1]])
    };
    count > 0 && tiff.len().saturating_sub(offset + 2) >= usize::from(count) * 12
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_validation_and_model_thumbnail_preserve_the_source_dimensions() {
        let pixels = [31u8, 63, 127].repeat(1600 * 1000);
        let original = encode(&pixels, 1600, 1000).unwrap();
        let prepared = prepare(&original).unwrap();
        assert_eq!((prepared.width, prepared.height), (1568, 980));
        assert_eq!(prepared.mode, "RGB");
        assert!(!prepared.has_exif);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(prepared.image_base64)
            .unwrap();
        let header = turbojpeg::read_header(&bytes).unwrap();
        assert_eq!((header.width, header.height), (1568, 980));
        assert!(prepare(b"invalid JPEG").is_none());
    }

    #[test]
    fn completed_jpeg_decode_with_recoverable_entropy_warning_matches_pillow() {
        // Synthetic one-pixel JPEG with an early entropy marker: Pillow.load()
        // accepts it, and libjpeg completes its pixel output with JWRN_HIT_MARKER.
        let original = base64::engine::general_purpose::STANDARD
            .decode(concat!(
                "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwg",
                "JC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAA",
                "AAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEI",
                "I0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1",
                "dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi",
                "4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APvV2yCo8X7/2Q==",
            ))
            .unwrap();
        let prepared = prepare(&original).unwrap();
        assert_eq!((prepared.width, prepared.height), (1, 1));
        assert_eq!(prepared.mode, "L");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&prepared.image_base64)
                .unwrap(),
            original
        );
        let parsed = super::super::document::parse(&original, ".jpg").unwrap();
        assert!(parsed.text.contains("尺寸: 1 x 1 像素"));
        assert!(parsed.text.contains("颜色模式: L"));
        assert_eq!(parsed.image_base64, Some(prepared.image_base64));

        // Pillow rejects missing EOI and missing scan data; this exception must
        // not turn either into an accepted upload.
        assert!(prepare(&original[..original.len() - 2]).is_none());
        let scan = original
            .windows(2)
            .position(|bytes| bytes == [0xff, 0xda])
            .unwrap();
        assert!(prepare(&original[..scan]).is_none());
        assert!(super::super::document::parse(&original[..original.len() - 2], ".jpg").is_err());
    }
}
