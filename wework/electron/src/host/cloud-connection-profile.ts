export async function readCloudConnection(storage: {
  read(): Promise<Record<string, string>>
}): Promise<unknown> {
  const raw = (await storage.read())['wework.cloudConnection']
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Stored cloud connection is invalid')
  }
}

export function requireCloudCredentialOwner(connection: unknown, apiBaseUrl: string): number {
  if (
    !connection ||
    typeof connection !== 'object' ||
    Array.isArray(connection) ||
    (connection as { apiBaseUrl?: unknown }).apiBaseUrl !== apiBaseUrl
  ) {
    throw new Error('Cloud credential destination is not configured')
  }
  const user = (connection as { user?: unknown }).user
  const id = user && typeof user === 'object' ? (user as { id?: unknown }).id : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Cloud credential account is unavailable')
  }
  return id
}

export interface CloudRuntimeTarget {
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
}

/** Bind native authentication to the complete saved destination, never renderer overrides. */
export function configuredCloudRuntimeTarget(
  target: unknown,
  connection: unknown
): { target: CloudRuntimeTarget; account: number } {
  if (!target || typeof target !== 'object' || Array.isArray(target))
    throw new Error('Cloud runtime target is not configured')
  const route = target as CloudRuntimeTarget
  const profile = connection as
    | (CloudRuntimeTarget & { token?: string; credentialMode?: string })
    | null
  if (
    !profile ||
    !['apiBaseUrl', 'socketBaseUrl', 'socketPath'].every(
      key =>
        typeof (target as Record<string, unknown>)[key] === 'string' &&
        (target as Record<string, unknown>)[key] ===
          (profile as unknown as Record<string, unknown>)[key]
    )
  )
    throw new Error('Cloud runtime target is not configured')
  const account = requireCloudCredentialOwner(profile, route.apiBaseUrl)
  return { target: route, account }
}

export async function configuredCloudRuntimeCredentials(
  target: unknown,
  connection: unknown,
  refresh: (apiBaseUrl: string, expectedUserId: number) => Promise<string>
): Promise<{ target: CloudRuntimeTarget; account: number; token: string }> {
  const { target: route, account } = configuredCloudRuntimeTarget(target, connection)
  const profile = connection as { token?: string; credentialMode?: string }
  const token =
    profile.credentialMode !== 'desktop_refresh' && profile.token
      ? profile.token
      : await refresh(route.apiBaseUrl, account)
  return { target: route, account, token }
}
