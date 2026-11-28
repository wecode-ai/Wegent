import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import type { RuntimeTaskAddress } from '@/types/runtime'

const aliases = new Map<string, string>()
const MAX_ALIASES = 64

export function recordMobileTaskAddressRename(
  previousAddress: RuntimeTaskAddress,
  nextAddress: RuntimeTaskAddress
): void {
  const previousKey = runtimeTaskKey(previousAddress)
  const nextKey = runtimeTaskKey(nextAddress)
  if (previousKey === nextKey) return
  aliases.delete(nextKey)
  aliases.set(nextKey, previousKey)
  while (aliases.size > MAX_ALIASES) {
    const oldest = aliases.keys().next().value
    if (!oldest) break
    aliases.delete(oldest)
  }
}

export function consumeMobileTaskAddressRenames(): ReadonlyMap<string, string> {
  const pending = new Map(aliases)
  aliases.clear()
  return pending
}

export function clearMobileTaskAddressRenames(): void {
  aliases.clear()
}
