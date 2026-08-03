// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function createWatermarkPattern(text: string): string {
  const width = 280
  const height = 180
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const canvas = document.createElement('canvas')
  canvas.width = width * ratio
  canvas.height = height * ratio
  const context = canvas.getContext('2d')
  if (!context) throw new Error('WATERMARK_CANVAS_UNAVAILABLE')

  context.scale(ratio, ratio)
  context.translate(width / 2, height / 2)
  context.rotate((-25 * Math.PI) / 180)
  context.font = '16px sans-serif'
  context.fillStyle = 'rgba(80, 80, 80, 0.18)'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, 0, 0)
  return canvas.toDataURL('image/png')
}
