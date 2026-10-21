export async function decodeDesktopControlImage(element: Element) {
  if (!(element instanceof HTMLImageElement)) {
    throw new Error('decodeImage requires an image element')
  }
  await element.decode()
  return {
    src: element.currentSrc || element.src,
    complete: element.complete,
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
  }
}
