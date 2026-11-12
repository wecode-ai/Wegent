import { NAVIGATION_PREVIEW_EDGE_PADDING_PX } from './turnNavigationConstants'

export interface PreviewClampInput {
  /** Vertical center of the preview before clamping, in navigation-local pixels. */
  centerTopPx: number
  previewHeightPx: number
  /** Top of the unobscured region, in navigation-local pixels. */
  regionTopPx: number
  /** Bottom of the unobscured region, in navigation-local pixels. */
  regionBottomPx: number
  edgePaddingPx?: number
}

/**
 * Keeps a hover preview inside the visible conversation region.
 *
 * The preview is positioned with `top` as its center (it is translated up by half
 * its height), so clamping the center directly keeps the whole card on screen.
 */
export function getClampedPreviewTopPx({
  centerTopPx,
  previewHeightPx,
  regionTopPx,
  regionBottomPx,
  edgePaddingPx = NAVIGATION_PREVIEW_EDGE_PADDING_PX,
}: PreviewClampInput): number {
  if (!Number.isFinite(centerTopPx)) return centerTopPx
  if (!Number.isFinite(previewHeightPx) || previewHeightPx <= 0) return centerTopPx
  if (!Number.isFinite(regionTopPx) || !Number.isFinite(regionBottomPx)) return centerTopPx
  if (regionBottomPx <= regionTopPx) return centerTopPx

  const halfPreviewHeightPx = previewHeightPx / 2
  const minimumPx = regionTopPx + halfPreviewHeightPx + edgePaddingPx
  const maximumPx = regionBottomPx - halfPreviewHeightPx - edgePaddingPx
  // A preview taller than the region cannot fit; keep its bottom above the
  // composer overlay and let it overflow upward instead.
  if (maximumPx < minimumPx) return regionBottomPx - halfPreviewHeightPx - edgePaddingPx
  return Math.min(Math.max(centerTopPx, minimumPx), maximumPx)
}
