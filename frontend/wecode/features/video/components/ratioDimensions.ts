/** Image and thumbnail dimensions per aspect ratio.
 *  Image height is fixed at 295px, width is calculated dynamically based on aspect ratio.
 */
export function getRatioDimensions(ratio?: string | null) {
  const fixedHeight = 295
  const [w, h] = (ratio || '16:9').split(':').map(Number)
  const imageWidth = Math.round(fixedHeight * (w / h))

  return {
    imageWidth,
    imageHeight: fixedHeight,
    thumbWidth: 72,
    thumbHeight: 48,
  }
}
