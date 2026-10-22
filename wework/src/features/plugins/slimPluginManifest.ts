/** Keep installation routing and policy while excluding heavy presentation fields. */
export function slimPluginManifestForCache(
  manifest?: Record<string, unknown> | null
): Record<string, unknown> {
  if (!manifest) return {}
  const keys = [
    'name',
    'id',
    'marketplaceId',
    'marketplacePath',
    'source',
    'installPolicy',
    'authPolicy',
    'availability',
    'disabledReason',
    'eligiblePlanTypes',
  ] as const
  return Object.fromEntries(
    keys.flatMap(key => (manifest[key] === undefined ? [] : [[key, manifest[key]]]))
  )
}
