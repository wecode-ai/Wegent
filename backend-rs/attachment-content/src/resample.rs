// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The Pillow resampling core the model-image preprocessing shares:
//! `Image.py:thumbnail`'s size rounding, `libImaging/Resample.c`'s coefficient
//! precomputation and 8-bit two-pass convolution, and `libImaging/Reduce.c`.
//!
//! Pillow 13.0.0 runs the horizontal pass first unless the source height is
//! scaled down more than twice as much as the width; both passes clip their
//! intermediate to 8 bits, so the pass order is observable in the output.

/// `PRECISION_BITS` in `libImaging/Resample.c`.
const PRECISION_BITS: u32 = 32 - 8 - 2;

/// `Image.thumbnail`'s `preserve_aspect_ratio`, including `round_aspect`.
pub(super) fn thumbnail_size(width: u32, height: u32, max: u32) -> Option<(u32, u32)> {
    if width <= max && height <= max {
        return None;
    }
    let aspect = width as f64 / height as f64;
    let limit = max as f64;
    // `Image.thumbnail`: `x / y >= aspect` with both provided edges at `max`.
    if aspect <= 1.0 {
        Some((
            round_aspect(limit * aspect, |n| (n / limit - aspect).abs()),
            max,
        ))
    } else {
        Some((
            max,
            round_aspect(limit / aspect, |n| {
                if n == 0.0 {
                    0.0
                } else {
                    (limit / n - aspect).abs()
                }
            }),
        ))
    }
}

/// `round_aspect(number, key) = max(min(floor(number), ceil(number), key=key), 1)`.
fn round_aspect(number: f64, key: impl Fn(f64) -> f64) -> u32 {
    let floor = number.floor();
    let ceil = number.ceil();
    // Python's `min(floor, ceil, key=key)` keeps the first of equal keys.
    let chosen = if key(floor) <= key(ceil) { floor } else { ceil };
    chosen.max(1.0) as u32
}

/// One output coordinate's tap range and normalized fixed-point weights.
struct Taps {
    start: usize,
    weights: Vec<i64>,
}

/// `Resample.c:precompute_coeffs` + `normalize_coeffs_8bpc`.
/// `Resample.c:precompute_coeffs` with an explicit source box
/// (`in0`/`in1`): the `resize` call after the `reducing_gap` pre-reduce
/// resamples a sub-rectangle of the reduced image.
fn precompute_box(in_size: usize, in0: f64, in1: f64, out_size: usize) -> Vec<Taps> {
    let scale = (in1 - in0) / out_size as f64;
    let filter_scale = scale.max(1.0);
    let support = 3.0 * filter_scale;
    let inverse_scale = 1.0 / filter_scale;
    let mut taps = Vec::with_capacity(out_size);
    for index in 0..out_size {
        let center = in0 + (index as f64 + 0.5) * scale;
        let mut start = (center - support + 0.5) as i64;
        if start < 0 {
            start = 0;
        }
        let mut end = (center + support + 0.5) as i64;
        if end > in_size as i64 {
            end = in_size as i64;
        }
        let count = (end - start) as usize;
        let mut weights: Vec<f64> = (0..count)
            .map(|tap| lanczos((tap as f64 + start as f64 - center + 0.5) * inverse_scale))
            .collect();
        let total: f64 = weights.iter().sum();
        if total != 0.0 {
            for weight in &mut weights {
                *weight /= total;
            }
        }
        let scaled = (1_i64 << PRECISION_BITS) as f64;
        let fixed = weights
            .into_iter()
            .map(|weight| {
                if weight < 0.0 {
                    (-0.5 + weight * scaled) as i64
                } else {
                    (0.5 + weight * scaled) as i64
                }
            })
            .collect();
        taps.push(Taps {
            start: start as usize,
            weights: fixed,
        });
    }
    taps
}

/// `lanczos_filter`: truncated sinc with a three-lobe support.
fn lanczos(x: f64) -> f64 {
    if (-3.0..3.0).contains(&x) {
        sinc(x) * sinc(x / 3.0)
    } else {
        0.0
    }
}

/// `sinc_filter`.
fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    let x = x * std::f64::consts::PI;
    x.sin() / x
}

/// The two-pass 8-bit resample: `Resample.c:ImagingResample`.
///
/// Pillow 13.0.0 runs the horizontal pass first unless the source height is
/// scaled down more than twice as much as the width; in that case the vertical
/// pass runs first. Both passes clip through `clip8`, so the intermediate
/// quantization makes the order observable.
pub(super) fn resample(
    pixels: &[u8],
    width: usize,
    height: usize,
    out_width: usize,
    out_height: usize,
    channels: usize,
) -> Vec<u8> {
    resample_box(
        pixels,
        width,
        height,
        out_width,
        out_height,
        channels,
        (0.0, 0.0, width as f64, height as f64),
    )
}

/// `Resample.c:ImagingResample` with a source `box`: the horizontal and
/// vertical coefficient sets are precomputed for the box, and the pass order
/// follows Pillow 13.0.0.
pub(super) fn resample_box(
    pixels: &[u8],
    width: usize,
    height: usize,
    out_width: usize,
    out_height: usize,
    channels: usize,
    source_box: (f64, f64, f64, f64),
) -> Vec<u8> {
    let (box_x0, box_y0, box_x1, box_y1) = source_box;
    // `Resample.c`: `xsize != imIn->xsize || box[0] || box[2] != xsize`.
    let need_horizontal = out_width != width || box_x0 != 0.0 || box_x1 != out_width as f64;
    let need_vertical = out_height != height || box_y0 != 0.0 || box_y1 != out_height as f64;
    if !need_horizontal && !need_vertical {
        return pixels.to_vec();
    }

    let horizontal_taps = need_horizontal.then(|| precompute_box(width, box_x0, box_x1, out_width));
    let vertical_taps = need_vertical.then(|| precompute_box(height, box_y0, box_y1, out_height));

    if horizontal_first(width, height, out_width, out_height) {
        let (intermediate, intermediate_width) = match horizontal_taps {
            Some(taps) => {
                let resampled = resample_horizontal(pixels, width, height, channels, &taps);
                (resampled, out_width)
            }
            None => (pixels.to_vec(), width),
        };
        match vertical_taps {
            Some(taps) => resample_vertical(&intermediate, intermediate_width, channels, &taps),
            None => intermediate,
        }
    } else {
        let (intermediate, intermediate_width, intermediate_height) = match vertical_taps {
            Some(taps) => {
                let resampled = resample_vertical(pixels, width, channels, &taps);
                (resampled, width, out_height)
            }
            None => (pixels.to_vec(), width, height),
        };
        match horizontal_taps {
            Some(taps) => resample_horizontal(
                &intermediate,
                intermediate_width,
                intermediate_height,
                channels,
                &taps,
            ),
            None => intermediate,
        }
    }
}

/// `Resample.c:ImagingResample`'s pass order (Pillow 13.0.0): "If height is
/// being scaled down more than twice the amount the width is, run the vertical
/// pass first, to make the horizontal pass faster."
fn horizontal_first(width: usize, height: usize, out_width: usize, out_height: usize) -> bool {
    let height_drop = height as i64 - out_height as i64;
    let width_drop = width as i64 - out_width as i64;
    !(height_drop > 0 && height_drop > width_drop * 2)
}

/// `Resample.c:ResampleHorizontal`: resample every source row into the output
/// width. Pillow windows the rows for the following vertical pass; row values
/// do not depend on the window, so every row is computed here.
fn resample_horizontal(
    pixels: &[u8],
    width: usize,
    height: usize,
    channels: usize,
    horizontal: &[Taps],
) -> Vec<u8> {
    let out_width = horizontal.len();
    let bias = 1_i64 << (PRECISION_BITS - 1);
    let mut output = vec![0u8; out_width * height * channels];
    for y in 0..height {
        let row = &pixels[y * width * channels..(y + 1) * width * channels];
        for (x, taps) in horizontal.iter().enumerate() {
            let target = (y * out_width + x) * channels;
            for channel in 0..channels {
                let mut accumulator = bias;
                for (tap, weight) in taps.weights.iter().enumerate() {
                    accumulator += row[(taps.start + tap) * channels + channel] as i64 * weight;
                }
                output[target + channel] = clip8(accumulator);
            }
        }
    }
    output
}

/// `Resample.c:ResampleVertical`: resample every source column into the output
/// height.
fn resample_vertical(pixels: &[u8], width: usize, channels: usize, vertical: &[Taps]) -> Vec<u8> {
    let out_height = vertical.len();
    let bias = 1_i64 << (PRECISION_BITS - 1);
    let mut output = vec![0u8; width * out_height * channels];
    for (y, taps) in vertical.iter().enumerate() {
        for x in 0..width {
            let target = (y * width + x) * channels;
            for channel in 0..channels {
                let mut accumulator = bias;
                for (tap, weight) in taps.weights.iter().enumerate() {
                    accumulator += pixels[((taps.start + tap) * width + x) * channels + channel]
                        as i64
                        * weight;
                }
                output[target + channel] = clip8(accumulator);
            }
        }
    }
    output
}

/// `Image.reduce` (`Reduce.c`): integer box averaging with
/// `(sum + n/2) / n` rounding per channel; the trailing partial block covers
/// only the remaining pixels.
pub(super) fn reduce(
    pixels: &[u8],
    width: usize,
    height: usize,
    channels: usize,
    factor: (usize, usize),
) -> Vec<u8> {
    let (factor_x, factor_y) = factor;
    let out_width = width.div_ceil(factor_x);
    let out_height = height.div_ceil(factor_y);
    let mut output = vec![0u8; out_width * out_height * channels];
    for y in 0..out_height {
        let y0 = y * factor_y;
        let rows = (height - y0).min(factor_y);
        for x in 0..out_width {
            let x0 = x * factor_x;
            let columns = (width - x0).min(factor_x);
            let count = (rows * columns) as i64;
            let half = count / 2;
            for channel in 0..channels {
                let mut sum = 0i64;
                for row in 0..rows {
                    let base = ((y0 + row) * width + x0) * channels + channel;
                    for column in 0..columns {
                        sum += pixels[base + column * channels] as i64;
                    }
                }
                output[(y * out_width + x) * channels + channel] =
                    ((sum + half) / count).clamp(0, 255) as u8;
            }
        }
    }
    output
}

/// `Resample.c:clip8`: the lookup table maps `-640..=639` to `0..=255`.
fn clip8(value: i64) -> u8 {
    let index = value >> PRECISION_BITS;
    index.clamp(0, 255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_sizes_match_pillows_round_aspect() {
        assert_eq!(thumbnail_size(4480, 1440, 1568), Some((1568, 504)));
        assert_eq!(thumbnail_size(750, 5100, 1568), Some((231, 1568)));
        assert_eq!(thumbnail_size(3420, 2016, 1568), Some((1568, 924)));
        assert_eq!(thumbnail_size(1881, 450, 1568), Some((1568, 375)));
        assert_eq!(thumbnail_size(966, 358, 1568), None);
    }

    #[test]
    fn a_solid_image_survives_the_resample_round_trip() {
        let pixels = [17u8, 34, 51, 255].repeat(64 * 64);
        let resized = resample(&pixels, 64, 64, 32, 32, 4);
        assert_eq!(resized.len(), 32 * 32 * 4);
        assert!(
            resized
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| *pixel == [17, 34, 51, 255])
        );
    }

    #[test]
    fn the_resample_pass_order_follows_pillow_13() {
        // `Resample.c` (13.0.0): a height scaled down more than twice as much
        // as the width runs the vertical pass first, so the 8-bit intermediate
        // quantization differs from the horizontal-first result.
        fn pixels(width: usize, height: usize) -> Vec<u8> {
            let mut data = Vec::with_capacity(width * height * 3);
            for y in 0..height {
                for x in 0..width {
                    for channel in 0..3 {
                        data.push(((x * 7 + y * 13 + channel * 29) % 256) as u8);
                    }
                }
            }
            data
        }
        fn fnv1a(bytes: &[u8]) -> u64 {
            bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
            })
        }

        // 30x12 -> 15x6: the height drop is smaller, so horizontal first.
        let wide = pixels(30, 12);
        let resized = resample(&wide, 30, 12, 15, 6, 3);
        assert_eq!(fnv1a(&resized), 0xd891_f802_7597_8eec);

        // 12x30 -> 6x15: the height drop (15) exceeds twice the width drop
        // (6), so Pillow 13 runs the vertical pass first. Pillow 12.3.0, which
        // always ran horizontal first, produces 0x6ae6_3107_8cbf_ceeb here.
        let tall = pixels(12, 30);
        let resized = resample(&tall, 12, 30, 6, 15, 3);
        assert_eq!(fnv1a(&resized), 0x4b55_ba17_2ecc_6399);
    }
}
