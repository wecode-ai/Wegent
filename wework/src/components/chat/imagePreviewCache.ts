const MAX_CACHED_IMAGE_COUNT = 32
const MAX_CACHED_IMAGE_BYTES = 64 * 1024 * 1024

interface CachedImageEntry {
  url: string
  size: number
  activeUsers: number
  lastUsed: number
}

export interface CachedImagePreview {
  url: string
  release: () => void
}

const cachedImages = new Map<string, CachedImageEntry>()
const pendingImages = new Map<string, Promise<CachedImageEntry>>()
let cachedImageBytes = 0
let accessSequence = 0
let cacheGeneration = 0

function removeCachedImage(key: string, entry: CachedImageEntry) {
  if (cachedImages.get(key) !== entry) return
  cachedImages.delete(key)
  cachedImageBytes -= entry.size
  URL.revokeObjectURL(entry.url)
}

function pruneCachedImages() {
  if (cachedImages.size <= MAX_CACHED_IMAGE_COUNT && cachedImageBytes <= MAX_CACHED_IMAGE_BYTES) {
    return
  }

  const unusedEntries = [...cachedImages.entries()]
    .filter(([, entry]) => entry.activeUsers === 0)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)

  for (const [key, entry] of unusedEntries) {
    removeCachedImage(key, entry)
    if (cachedImages.size <= MAX_CACHED_IMAGE_COUNT && cachedImageBytes <= MAX_CACHED_IMAGE_BYTES) {
      break
    }
  }
}

async function loadCachedImage(
  key: string,
  loadBlob: () => Promise<Blob>
): Promise<CachedImageEntry> {
  const existing = cachedImages.get(key)
  if (existing) return existing

  const pending = pendingImages.get(key)
  if (pending) return pending

  const generation = cacheGeneration
  const next = loadBlob()
    .then(blob => {
      if (generation !== cacheGeneration) {
        throw new Error('Image preview cache was cleared while loading')
      }

      const entry: CachedImageEntry = {
        url: URL.createObjectURL(blob),
        size: blob.size,
        activeUsers: 0,
        lastUsed: ++accessSequence,
      }
      cachedImages.set(key, entry)
      cachedImageBytes += entry.size
      return entry
    })
    .finally(() => {
      if (pendingImages.get(key) === next) {
        pendingImages.delete(key)
      }
    })
  pendingImages.set(key, next)
  return next
}

export async function acquireCachedImagePreview(
  key: string,
  loadBlob: () => Promise<Blob>
): Promise<CachedImagePreview> {
  const entry = await loadCachedImage(key, loadBlob)
  entry.activeUsers += 1
  entry.lastUsed = ++accessSequence
  pruneCachedImages()

  let released = false
  return {
    url: entry.url,
    release: () => {
      if (released) return
      released = true
      entry.activeUsers = Math.max(0, entry.activeUsers - 1)
      entry.lastUsed = ++accessSequence
      pruneCachedImages()
    },
  }
}

export function clearImagePreviewCache() {
  cacheGeneration += 1
  for (const [key, entry] of cachedImages) {
    removeCachedImage(key, entry)
  }
  pendingImages.clear()
}
