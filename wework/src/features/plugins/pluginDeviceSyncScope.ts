interface ScopeReferences {
  lifetime: { readonly current: symbol | null }
  marketplaceKey: { readonly current: string }
  deviceId: { readonly current: string | null }
}

export function capturePluginDeviceSyncScope(
  references: ScopeReferences,
  marketplaceKey: string,
  deviceId: string
): () => boolean {
  const lifetime = references.lifetime.current
  return () =>
    lifetime !== null &&
    references.lifetime.current === lifetime &&
    references.marketplaceKey.current === marketplaceKey &&
    references.deviceId.current === deviceId
}
