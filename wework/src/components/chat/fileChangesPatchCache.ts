import { getSingularPatch, type FileDiffMetadata } from '@pierre/diffs'

const MAX_CACHED_PATCHES = 100
const MAX_CACHED_PATCH_BYTES = 8 * 1024 * 1024

let cacheKeySequence = 0

interface CachedPatch {
  diff: FileDiffMetadata
  bytes: number
}

export function createFileChangesPatchCache(
  maxEntries = MAX_CACHED_PATCHES,
  maxBytes = MAX_CACHED_PATCH_BYTES
) {
  const entries = new Map<string, CachedPatch>()
  let retainedBytes = 0

  // Budget source strings and the text retained in parsed lines by UTF-16
  // capacity without encoding or copying them during the initial render.
  const entryBytes = (patch: string, diff: FileDiffMetadata) =>
    2 * (patch.length + diff.additionCharacterCount + diff.deletionCharacterCount)

  return (patch: string): FileDiffMetadata => {
    const cached = entries.get(patch)
    if (cached) {
      entries.delete(patch)
      entries.set(patch, cached)
      return cached.diff
    }

    // Use exactly the same parser and validation as Pierre's PatchDiff.
    const diff = getSingularPatch(patch)
    const bytes = entryBytes(patch, diff)
    if (bytes > maxBytes || maxEntries <= 0) return diff

    while (entries.size >= maxEntries || retainedBytes + bytes > maxBytes) {
      const oldest = entries.entries().next().value
      if (!oldest) break
      const [key, previous] = oldest
      entries.delete(key)
      retainedBytes -= previous.bytes
    }
    // A distinct key per exact patch prevents stale WorkerPool AST reuse.
    diff.cacheKey = `wework-review-patch:${++cacheKeySequence}`
    entries.set(patch, { diff, bytes })
    retainedBytes += bytes
    return diff
  }
}

export const getCachedFileChangesPatch = createFileChangesPatchCache()
