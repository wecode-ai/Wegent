// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties } from 'react'

export type GeneratedImageDisplayLayout = Pick<CSSProperties, 'aspectRatio' | 'width' | 'height'>

const GENERATED_IMAGE_SHORT_EDGE = 220

export function resolveGeneratedImageDisplayLayout(
  imageSize?: string
): GeneratedImageDisplayLayout {
  const match = imageSize?.trim().match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/i)
  if (!match) {
    return {
      aspectRatio: '1 / 1',
      width: GENERATED_IMAGE_SHORT_EDGE,
      height: GENERATED_IMAGE_SHORT_EDGE,
    }
  }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      aspectRatio: '1 / 1',
      width: GENERATED_IMAGE_SHORT_EDGE,
      height: GENERATED_IMAGE_SHORT_EDGE,
    }
  }

  const aspectRatio = `${width} / ${height}`
  const scaleDimension = (value: number) => Math.round(value * 100) / 100

  return width > height
    ? {
        aspectRatio,
        width: scaleDimension((GENERATED_IMAGE_SHORT_EDGE * width) / height),
        height: GENERATED_IMAGE_SHORT_EDGE,
      }
    : {
        aspectRatio,
        width: GENERATED_IMAGE_SHORT_EDGE,
        height: scaleDimension((GENERATED_IMAGE_SHORT_EDGE * height) / width),
      }
}
