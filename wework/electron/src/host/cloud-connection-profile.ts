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
