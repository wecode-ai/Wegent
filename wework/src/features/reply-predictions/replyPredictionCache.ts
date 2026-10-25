import type { RuntimeTaskAddress } from '@/types/api'

interface CachedPrediction {
  key: string
  text: string | null
  accepted: boolean
  failed: boolean
}

const storagePrefix = 'wework.replyPrediction.v1.'
const storageKey = (scope: string) => `${storagePrefix}${scope}`

export function removeReplyPredictionCache(address: RuntimeTaskAddress) {
  const taskPrefix = `${storagePrefix}${JSON.stringify([address.deviceId, address.taskId]).slice(0, -1)},`
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(taskPrefix)) localStorage.removeItem(key)
    }
  } catch {
    console.debug('[Wework] Reply prediction cache could not be removed')
  }
}

export function readReplyPrediction(scope: string, key: string): CachedPrediction | null {
  try {
    const raw = localStorage.getItem(storageKey(scope))
    if (!raw) return null
    const cached: unknown = JSON.parse(raw)
    if (
      !cached ||
      typeof cached !== 'object' ||
      !('key' in cached) ||
      cached.key !== key ||
      !('text' in cached) ||
      (cached.text !== null && typeof cached.text !== 'string') ||
      !('accepted' in cached) ||
      typeof cached.accepted !== 'boolean' ||
      !('failed' in cached) ||
      typeof cached.failed !== 'boolean'
    )
      return null
    return cached as CachedPrediction
  } catch {
    console.debug('[Wework] Reply prediction cache could not be read')
    return null
  }
}

export function writeReplyPrediction(scope: string, cached: CachedPrediction) {
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(cached))
  } catch {
    console.debug('[Wework] Reply prediction cache could not be saved')
  }
}
