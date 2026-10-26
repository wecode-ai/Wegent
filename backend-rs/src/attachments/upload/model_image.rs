// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The model-image preprocessing `POST /api/attachments/upload` runs before it
//! inlines an attachment's image payload
//! (`shared/utils/image_preprocessor.py:prepare_image_bytes_for_model`).
//!
//! The source pipeline is Pillow:
//! 1. `Image.open` validates the pixels and reports the original format, size,
//!    mode, and EXIF presence (`parser.py:_parse_image`).
//! 2. `prepare_image_bytes_for_model` leaves the bytes untouched unless the
//!    long edge exceeds `MAX_MODEL_IMAGE_LONG_EDGE` (1568), the output format
//!    differs, or a byte budget requires compression.
//! 3. Otherwise it copies the decoded image, calls
//!    `thumbnail((1568, 1568), LANCZOS, reducing_gap=3.0)`, and saves it as
//!    `PNG` with `optimize=True`.
//!
//! Every step below mirrors Pillow 13.0.0 (the version the recording source
//! runs) so the produced bytes match the source byte-for-byte:
//! `Image.py:thumbnail`/`resize`, `libImaging/Resample.c` (the pass order,
//! coefficient precomputation, the 22-bit fixed-point convolution, and the
//! `+0.5` accumulator bias), `libImaging/Convert.c`'s premultiplied `RGBa`
//! round trip, and `libImaging/ZipEncode.c` (adaptive scanline filters plus
//! `deflateInit2(level=9, windowBits=15, memLevel=9, Z_FILTERED)`). PNG IDAT
//! chunks are bounded by `ImageFile.MAXBLOCK` (65536).
//!
//! Pillow 13.0.0 changed only one resample rule from 12.x: when the height is
//! scaled down more than twice as much as the width, the vertical pass runs
//! first. Both passes quantize their intermediate to 8 bits, so the order is
//! part of the output and reproduces the recording.
//!
//! Decoding covers the non-interlaced 8-bit PNG modes (grayscale, RGB, RGBA,
//! gray+alpha, and palette), which is the set the recording corpus contains;
//! other PNG variants keep the caller's existing
//! `unsupported_type` behavior instead of guessing at pixels.
use std::io::{Read, Write};

use super::resample::{resample, thumbnail_size};

use base64::Engine as _;
use flate2::Crc;
use flate2::read::ZlibDecoder;

/// `MAX_MODEL_IMAGE_LONG_EDGE`.
pub(super) const MAX_MODEL_IMAGE_LONG_EDGE: u32 = 1568;
/// Pillow's `Image.MAX_IMAGE_PIXELS`; larger images raise a decode error.
pub(super) const MAX_IMAGE_PIXELS: u64 = 89_478_485;
/// `ImageFile.MAXBLOCK`: the PNG encoder's IDAT chunk size.
const MAX_BLOCK: usize = 65_536;

/// A decoded PNG image with 8 bits per channel.
#[derive(Debug)]
pub(super) struct DecodedImage {
    pub(super) width: u32,
    pub(super) height: u32,
    /// 1 (L), 2 (LA), 3 (RGB), or 4 (RGBA).
    pub(super) channels: usize,
    pub(super) pixels: Vec<u8>,
    pub(super) icc_profile: Option<Vec<u8>>,
}

/// The bytes and dimensions the caller embeds in `subtask_contexts`.
#[derive(Debug)]
pub(super) struct PreparedModelImage {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// `prepare_image_bytes_for_model(image_data, mime_type, max_long_edge)`.
///
/// Returns `None` when the image cannot be decoded or normalized; the source
/// treats that as `_unchanged`, so the caller keeps the original bytes and
/// dimensions. Only the resize path is implemented: the caller reaches this
/// function for PNG uploads, whose input and output MIME type are both
/// `image/png`, so `needs_convert` is always false and `max_size_bytes` is
/// unset.
pub(super) fn prepare_image_bytes_for_model(
    image_data: &[u8],
    max_long_edge: u32,
) -> Option<PreparedModelImage> {
    let decoded = decode_png(image_data)?;
    let (width, height) = (decoded.width, decoded.height);
    let target = thumbnail_size(width, height, max_long_edge);
    let Some((target_width, target_height)) = target else {
        return Some(PreparedModelImage {
            data: image_data.to_vec(),
            width,
            height,
        });
    };

    let (pixels, target_channels) = match decoded.channels {
        // `Image.py` resizes RGBA through premultiplied `RGBa`.
        4 => (premultiply(&decoded.pixels), 4),
        // `_normalize_mode_for_output` leaves grayscale/RGB modes alone; Pillow
        // saves them as `L`/`LA`/`RGB`, and only RGB(A) appear in the corpus.
        channels => (decoded.pixels.clone(), channels),
    };
    let resized = resample(
        &pixels,
        width as usize,
        height as usize,
        target_width as usize,
        target_height as usize,
        target_channels,
    );
    let pixels = if target_channels == 4 {
        unpremultiply(&resized)
    } else {
        resized
    };
    let data = encode_png(
        target_width,
        target_height,
        &pixels,
        target_channels,
        decoded.icc_profile.as_deref(),
    )?;
    Some(PreparedModelImage {
        data,
        width: target_width,
        height: target_height,
    })
}

/// The base64 payload and prepared dimensions `_parse_image` inlines, or
/// `None` when the image bytes cannot be normalized (the source then keeps the
/// original bytes and dimensions).
pub(super) fn inline_image(image_data: &[u8]) -> (String, Option<(u32, u32)>) {
    let engine = base64::engine::general_purpose::STANDARD;
    match prepare_image_bytes_for_model(image_data, MAX_MODEL_IMAGE_LONG_EDGE) {
        Some(prepared) => (
            engine.encode(&prepared.data),
            Some((prepared.width, prepared.height)),
        ),
        None => (engine.encode(image_data), None),
    }
}

/// `Image.py`: `RGBA` -> `RGBa` (`Convert.c:rgbA2rgba`).
pub(super) fn premultiply(pixels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len());
    for pixel in pixels.as_chunks::<4>().0 {
        let alpha = pixel[3] as u32;
        out.push(muldiv255(pixel[0] as u32, alpha) as u8);
        out.push(muldiv255(pixel[1] as u32, alpha) as u8);
        out.push(muldiv255(pixel[2] as u32, alpha) as u8);
        out.push(pixel[3]);
    }
    out
}

/// `Image.py`: `RGBa` -> `RGBA` (`Convert.c:rgba2rgbA`).
pub(super) fn unpremultiply(pixels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len());
    for pixel in pixels.as_chunks::<4>().0 {
        let alpha = pixel[3] as u32;
        if alpha == 0 || alpha == 255 {
            out.extend_from_slice(pixel);
        } else {
            for channel in &pixel[..3] {
                out.push(((255 * *channel as u32) / alpha).min(255) as u8);
            }
            out.push(pixel[3]);
        }
    }
    out
}

/// `MULDIV255`: like `(a * b + 127) / 255`, rounded as Pillow does.
fn muldiv255(a: u32, b: u32) -> u32 {
    let tmp = a * b + 128;
    ((tmp >> 8) + tmp) >> 8
}

/// `Image.save(..., format="PNG", optimize=True)` for an 8-bit L/LA/RGB/RGBA
/// image: adaptive scanline filters, then `deflateInit2` level 9, windowBits
/// 15, memLevel 9, `Z_FILTERED`, in 64 KiB IDAT chunks.
fn encode_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    channels: usize,
    icc_profile: Option<&[u8]>,
) -> Option<Vec<u8>> {
    let color_type: u8 = match channels {
        1 => 0,
        2 => 4,
        3 => 2,
        4 => 6,
        _ => return None,
    };
    let stride = width as usize * channels;
    let mut filtered = Vec::with_capacity(height as usize * (stride + 1));
    let mut previous = vec![0u8; stride];
    for y in 0..height as usize {
        let row = &pixels[y * stride..(y + 1) * stride];
        let (filter, bytes) = select_filter(row, &previous, channels);
        filtered.push(filter);
        filtered.extend_from_slice(&bytes);
        previous.copy_from_slice(row);
    }

    let compressed = deflate_filtered(&filtered)?;

    let mut png = Vec::with_capacity(compressed.len() + 128);
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
    write_chunk(&mut png, b"IHDR", &ihdr);
    // Pillow preserves the decoded profile through copy/thumbnail, and its
    // PNG writer normalizes the name and re-compresses with zlib defaults.
    if let Some(profile) = icc_profile {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(profile).ok()?;
        let mut chunk = b"ICC Profile\0\0".to_vec();
        chunk.extend_from_slice(&encoder.finish().ok()?);
        write_chunk(&mut png, b"iCCP", &chunk);
    }
    for chunk in compressed.chunks(MAX_BLOCK) {
        write_chunk(&mut png, b"IDAT", chunk);
    }
    write_chunk(&mut png, b"IEND", &[]);
    Some(png)
}

/// `ZipEncode.c`: pick the scanline filter with the smallest sum of absolute
/// signed bytes, trying none, up, sub, average, then paeth in that order.
fn select_filter(row: &[u8], previous: &[u8], bpp: usize) -> (u8, Vec<u8>) {
    let mut best = (0u8, row.to_vec());
    let mut best_sum = absolute_sum(row);
    if best_sum == 0 {
        return best;
    }
    let candidates = [
        (2u8, up_filter(row, previous)),
        (1u8, sub_filter(row, bpp)),
        (3u8, average_filter(row, previous, bpp)),
        (4u8, paeth_filter(row, previous, bpp)),
    ];
    for (filter, bytes) in candidates {
        let sum = absolute_sum(&bytes);
        if sum < best_sum {
            best = (filter, bytes);
            best_sum = sum;
        }
    }
    best
}

/// `ZipEncode.c`'s `(v < 128) ? v : 256 - v` distance.
fn absolute_sum(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .map(|value| {
            if *value < 128 {
                *value as u64
            } else {
                256 - *value as u64
            }
        })
        .sum()
}

fn up_filter(row: &[u8], previous: &[u8]) -> Vec<u8> {
    row.iter()
        .zip(previous)
        .map(|(value, prior)| value.wrapping_sub(*prior))
        .collect()
}

fn sub_filter(row: &[u8], bpp: usize) -> Vec<u8> {
    row.iter()
        .enumerate()
        .map(|(index, value)| {
            let left = if index >= bpp { row[index - bpp] } else { 0 };
            value.wrapping_sub(left)
        })
        .collect()
}

fn average_filter(row: &[u8], previous: &[u8], bpp: usize) -> Vec<u8> {
    row.iter()
        .enumerate()
        .map(|(index, value)| {
            let left = if index >= bpp {
                row[index - bpp] as u32
            } else {
                0
            };
            value.wrapping_sub(((left + previous[index] as u32) / 2) as u8)
        })
        .collect()
}

fn paeth_filter(row: &[u8], previous: &[u8], bpp: usize) -> Vec<u8> {
    row.iter()
        .enumerate()
        .map(|(index, value)| {
            let (left, upper_left) = if index >= bpp {
                (row[index - bpp] as i32, previous[index - bpp] as i32)
            } else {
                (0, 0)
            };
            let upper = previous[index] as i32;
            value.wrapping_sub(paeth(left, upper, upper_left) as u8)
        })
        .collect()
}

/// The PNG Paeth predictor.
fn paeth(a: i32, b: i32, c: i32) -> i32 {
    let pa = (b - c).abs();
    let pb = (a - c).abs();
    let pc = (a + b - 2 * c).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// One PNG chunk: length, type, data, and the CRC over type+data.
fn write_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let mut crc = Crc::new();
    crc.update(kind);
    crc.update(data);
    png.extend_from_slice(&crc.sum().to_be_bytes());
}

/// Decode a non-interlaced 8-bit or 16-bit PNG. Returns `None` for formats
/// outside this module's subset so the caller keeps its existing
/// `unsupported_type` behavior.
///
/// 16-bit samples follow Pillow's mode mapping (`PngImagePlugin._MODES`):
/// truecolour and truecolour+alpha load as `RGB`/`RGBA` keeping each
/// sample's high byte; grayscale+alpha loads as `RGBA` with the gray value
/// in all three channels; 16-bit grayscale loads as `I;16`, which this port
/// does not resize, so it stays outside the subset.
pub(super) fn decode_png(data: &[u8]) -> Option<DecodedImage> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if data.len() < 8 || &data[..8] != SIGNATURE {
        return None;
    }
    let mut offset = 8;
    let mut header: Option<(u32, u32, u8, u8, u8)> = None;
    let mut palette: Option<Vec<u8>> = None;
    let mut icc_profile = None;
    let mut compressed = Vec::new();
    while offset + 8 <= data.len() {
        let length = u32::from_be_bytes(data[offset..offset + 4].try_into().ok()?) as usize;
        let kind = &data[offset + 4..offset + 8];
        let start = offset + 8;
        let end = start.checked_add(length)?;
        if end.checked_add(4)? > data.len() {
            return None;
        }
        let body = &data[start..end];
        match kind {
            b"IHDR" if length == 13 => {
                header = Some((
                    u32::from_be_bytes(body[0..4].try_into().ok()?),
                    u32::from_be_bytes(body[4..8].try_into().ok()?),
                    body[8],
                    body[9],
                    body[12],
                ));
            }
            b"PLTE" => palette = Some(body.to_vec()),
            b"iCCP" => {
                let separator = body.iter().position(|byte| *byte == 0)?;
                if body.get(separator + 1) != Some(&0) {
                    return None;
                }
                // Pillow's MAX_TEXT_CHUNK bounds decompressed ICC profiles.
                const MAX_PROFILE_BYTES: u64 = 1_048_576;
                let mut profile = Vec::new();
                ZlibDecoder::new(body.get(separator + 2..)?)
                    .take(MAX_PROFILE_BYTES + 1)
                    .read_to_end(&mut profile)
                    .ok()?;
                if profile.len() as u64 > MAX_PROFILE_BYTES {
                    return None;
                }
                icc_profile = Some(profile);
            }
            b"IDAT" => compressed.extend_from_slice(body),
            b"IEND" => break,
            _ => {}
        }
        offset = end + 4;
    }
    let (width, height, bit_depth, color_type, interlace) = header?;
    if !matches!(bit_depth, 8 | 16) || interlace != 0 || width == 0 || height == 0 {
        return None;
    }
    // 16-bit grayscale is the `I;16` mode, which this port does not resize.
    if bit_depth == 16 && color_type == 0 {
        return None;
    }
    let channels = match color_type {
        0 => 1,
        2 => 3,
        3 => 1,
        4 => 2,
        6 => 4,
        _ => return None,
    };
    if color_type == 3 && palette.as_ref().is_none_or(|plte| plte.len() < 3) {
        return None;
    }
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return None;
    }
    let sample_bytes = usize::from(bit_depth == 16) + 1;
    let stride = width as usize * channels * sample_bytes;
    let expected = (stride + 1).checked_mul(height as usize)?;
    let mut decoder = ZlibDecoder::new(compressed.as_slice()).take(expected as u64 + 1);
    let mut raw = Vec::with_capacity(expected);
    decoder.read_to_end(&mut raw).ok()?;
    if raw.len() != expected {
        return None;
    }

    // `bpp` for the filters is bytes per pixel, so 16-bit samples filter on
    // the full two-byte sample.
    let filter_bpp = channels * sample_bytes;
    let mut pixels = vec![0u8; stride * height as usize];
    let mut previous = vec![0u8; stride];
    for y in 0..height as usize {
        let filter = raw[y * (stride + 1)];
        let line = &raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)];
        let target = &mut pixels[y * stride..(y + 1) * stride];
        unfilter(filter, line, &previous, target, filter_bpp)?;
        previous.copy_from_slice(target);
    }
    let pixels = if color_type == 3 {
        expand_palette(&pixels, palette.as_deref()?)
    } else if bit_depth == 16 {
        truncate_16bit_samples(&pixels, color_type)
    } else {
        pixels
    };
    let channels = if color_type == 3 {
        3
    } else if color_type == 4 && bit_depth == 16 {
        // Pillow loads 16-bit grayscale+alpha as `RGBA`.
        4
    } else {
        channels
    };
    Some(DecodedImage {
        width,
        height,
        channels,
        pixels,
        icc_profile,
    })
}

/// The 8-bit view of 16-bit big-endian samples: each sample keeps its high
/// byte, and 16-bit grayscale+alpha expands to RGBA with the gray value in
/// every colour channel (`PngImagePlugin._MODES`).
fn truncate_16bit_samples(pixels: &[u8], color_type: u8) -> Vec<u8> {
    match color_type {
        // `LA;16B` -> `RGBA`: gray in R, G and B, alpha kept.
        4 => {
            let mut out = Vec::with_capacity(pixels.len() / 2);
            for sample in pixels.as_chunks::<4>().0 {
                let gray = sample[0];
                out.extend_from_slice(&[gray, gray, gray, sample[2]]);
            }
            out
        }
        // `RGB;16B`/`RGBA;16B` -> `RGB`/`RGBA`: the high byte of each sample.
        _ => pixels
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| pair[0])
            .collect(),
    }
}

/// Reverse one PNG scanline filter.
fn unfilter(filter: u8, line: &[u8], previous: &[u8], target: &mut [u8], bpp: usize) -> Option<()> {
    match filter {
        0 => target.copy_from_slice(line),
        1 => {
            for index in 0..line.len() {
                let left = if index >= bpp { target[index - bpp] } else { 0 };
                target[index] = line[index].wrapping_add(left);
            }
        }
        2 => {
            for index in 0..line.len() {
                target[index] = line[index].wrapping_add(previous[index]);
            }
        }
        3 => {
            for index in 0..line.len() {
                let left = if index >= bpp {
                    target[index - bpp] as u32
                } else {
                    0
                };
                let average = ((left + previous[index] as u32) / 2) as u8;
                target[index] = line[index].wrapping_add(average);
            }
        }
        4 => {
            for index in 0..line.len() {
                let (left, upper_left) = if index >= bpp {
                    (target[index - bpp] as i32, previous[index - bpp] as i32)
                } else {
                    (0, 0)
                };
                let upper = previous[index] as i32;
                target[index] = line[index].wrapping_add(paeth(left, upper, upper_left) as u8);
            }
        }
        _ => return None,
    }
    Some(())
}

/// Expand palette indices to RGB.
fn expand_palette(indices: &[u8], palette: &[u8]) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(indices.len() * 3);
    for index in indices {
        let start = *index as usize * 3;
        if start + 2 < palette.len() {
            pixels.extend_from_slice(&palette[start..start + 3]);
        } else {
            pixels.extend_from_slice(&[0, 0, 0]);
        }
    }
    pixels
}

/// The `z_stream` layout zlib expects, with nullable allocator hooks.
///
/// `libz_sys::z_stream` declares `zalloc`/`zfree` as non-nullable function
/// pointers, so a zeroed `libz_sys::z_stream` is not a valid Rust value even
/// though zlib's API requires exactly those null hooks. This mirror struct has
/// the same C layout and expresses the hooks as `Option`, which is sound.
#[repr(C)]
struct ZStream {
    next_in: *mut u8,
    avail_in: u32,
    total_in: std::os::raw::c_ulong,
    next_out: *mut u8,
    avail_out: u32,
    total_out: std::os::raw::c_ulong,
    msg: *mut std::os::raw::c_char,
    state: *mut std::os::raw::c_void,
    zalloc: Option<
        unsafe extern "C" fn(*mut std::os::raw::c_void, u32, u32) -> *mut std::os::raw::c_void,
    >,
    zfree: Option<unsafe extern "C" fn(*mut std::os::raw::c_void, *mut std::os::raw::c_void)>,
    opaque: *mut std::os::raw::c_void,
    data_type: std::os::raw::c_int,
    adler: std::os::raw::c_ulong,
    reserved: std::os::raw::c_ulong,
}

impl ZStream {
    fn new() -> Self {
        Self {
            next_in: std::ptr::null_mut(),
            avail_in: 0,
            total_in: 0,
            next_out: std::ptr::null_mut(),
            avail_out: 0,
            total_out: 0,
            msg: std::ptr::null_mut(),
            state: std::ptr::null_mut(),
            zalloc: None,
            zfree: None,
            opaque: std::ptr::null_mut(),
            data_type: 0,
            adler: 0,
            reserved: 0,
        }
    }

    fn as_libz(&mut self) -> *mut libz_sys::z_stream {
        self as *mut Self as *mut libz_sys::z_stream
    }
}

/// Pillow's `ZipEncode.c` compresses with zlib's
/// `deflateInit2(level=9, Z_DEFLATED, windowBits=15, memLevel=9, Z_FILTERED)`.
///
/// The call is bounded by `deflateBound` and the input is the filtered
/// scanline stream, which is already bounded by the upload size limit. The
/// stream is initialized once and ended on every path, and no pointer into the
/// input or output buffers outlives this function.
#[allow(unsafe_code)]
fn deflate_filtered(input: &[u8]) -> Option<Vec<u8>> {
    if input.len() > u32::MAX as usize {
        return None;
    }
    let mut stream = ZStream::new();
    // SAFETY: `ZStream` mirrors the C `z_stream` layout and starts with null
    // allocator hooks, which is the documented `deflateInit2_` input.
    let initialized = unsafe {
        libz_sys::deflateInit2_(
            stream.as_libz(),
            9,
            libz_sys::Z_DEFLATED,
            15,
            9,
            libz_sys::Z_FILTERED,
            libz_sys::zlibVersion(),
            std::mem::size_of::<libz_sys::z_stream>() as std::os::raw::c_int,
        )
    };
    if initialized != libz_sys::Z_OK {
        return None;
    }
    // SAFETY: the stream is initialized; `deflateBound` only reads it.
    let bound = unsafe { libz_sys::deflateBound(stream.as_libz(), input.len() as libz_sys::uLong) };
    let mut output = vec![0u8; bound as usize];
    // SAFETY: both buffers outlive every `deflate` call, and zlib only reads
    // `next_in` and writes inside `avail_out`. `deflateEnd` runs on both paths.
    stream.next_in = input.as_ptr() as *mut u8;
    stream.avail_in = input.len() as u32;
    stream.next_out = output.as_mut_ptr();
    stream.avail_out = output.len() as u32;
    let status = unsafe {
        let status = libz_sys::deflate(stream.as_libz(), libz_sys::Z_FINISH);
        libz_sys::deflateEnd(stream.as_libz());
        status
    };
    if status != libz_sys::Z_STREAM_END {
        return None;
    }
    output.truncate(stream.total_out as usize);
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_png_encoder_round_trips_through_the_decoder() {
        let pixels: Vec<u8> = (0..32 * 8 * 4).map(|value| (value * 7) as u8).collect();
        let png = encode_png(32, 8, &pixels, 4, None).expect("png encodes");
        let decoded = decode_png(&png).expect("png decodes");
        assert_eq!((decoded.width, decoded.height), (32, 8));
        assert_eq!(decoded.channels, 4);
        assert_eq!(decoded.pixels, pixels);
    }

    #[test]
    fn thumbnail_preserves_the_color_profile() {
        let pixels = [17u8, 34, 51, 255].repeat(64 * 64);
        let profile = b"synthetic ICC profile";
        let png = encode_png(64, 64, &pixels, 4, Some(profile)).unwrap();
        let prepared = prepare_image_bytes_for_model(&png, 32).unwrap();
        let decoded = decode_png(&prepared.data).unwrap();
        assert_eq!((decoded.width, decoded.height), (32, 32));
        assert_eq!(decoded.icc_profile.as_deref(), Some(profile.as_slice()));
    }

    /// A PNG named `.jpg` stays on Pillow's content-detected PNG decode path;
    /// the extension-derived MIME only selects the JPEG output format.
    #[test]
    fn png_content_named_jpeg_uses_png_decode_with_jpeg_output() {
        let engine = base64::engine::general_purpose::STANDARD;

        // No resize: `prepare_image_bytes_for_model` keeps the upload bytes.
        let small: Vec<u8> = (0..64 * 8 * 3).map(|value| (value * 11) as u8).collect();
        let small_png = encode_png(64, 8, &small, 3, None).unwrap();
        let (small_base64, small_size) = super::super::model_jpeg::prepare_png_as_jpeg(&small_png);
        assert_eq!(small_size, None);
        assert_eq!(engine.decode(small_base64).unwrap(), small_png);

        // 1600x800 exceeds the model long edge: resize to 1568x784 and encode
        // the PNG pixels as JPEG.
        let large: Vec<u8> = (0..1600 * 800 * 3).map(|value| (value * 7) as u8).collect();
        let large_png = encode_png(1600, 800, &large, 3, None).unwrap();
        let (large_base64, large_size) = super::super::model_jpeg::prepare_png_as_jpeg(&large_png);
        assert_eq!(large_size, Some((1568, 784)));
        let jpeg = engine.decode(large_base64).unwrap();
        let header = turbojpeg::read_header(&jpeg).unwrap();
        assert_eq!((header.width, header.height), (1568, 784));
    }
}
