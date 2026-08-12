// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function formatAspectRatioLimit(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value)
  if (value >= 1) {
    const rounded = Math.round(value)
    return Math.abs(value - rounded) < 0.001 ? `${rounded}:1` : `${value.toFixed(2)}:1`
  }
  const inverse = 1 / value
  const rounded = Math.round(inverse)
  return Math.abs(inverse - rounded) < 0.001 ? `1:${rounded}` : `1:${inverse.toFixed(2)}`
}

const STANDARD_VIDEO_PIXEL_COUNTS = [
  { label: '480P', pixels: 854 * 480 },
  { label: '720P', pixels: 1280 * 720 },
  { label: '1080P', pixels: 1920 * 1080 },
  { label: '2K', pixels: 2560 * 1440 },
  { label: '4K', pixels: 3840 * 2160 },
] as const

export function formatVideoPixelLimit(pixelCount: number): string {
  if (!Number.isFinite(pixelCount) || pixelCount <= 0) return String(pixelCount)

  const standardResolution = STANDARD_VIDEO_PIXEL_COUNTS.find(
    option => Math.abs(pixelCount - option.pixels) / option.pixels <= 0.05
  )
  if (standardResolution) return standardResolution.label

  const megapixels = pixelCount / 1_000_000
  return `${megapixels.toFixed(megapixels >= 10 ? 1 : 2).replace(/\.?0+$/, '')} MP`
}
