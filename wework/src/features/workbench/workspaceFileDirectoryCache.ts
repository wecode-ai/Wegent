export const WORKSPACE_DIRECTORY_CACHE_TTL_MS = 3_000

export function isWorkspaceDirectoryCacheFresh(
  loadedAt: number | undefined,
  now = Date.now()
): boolean {
  return loadedAt !== undefined && now - loadedAt < WORKSPACE_DIRECTORY_CACHE_TTL_MS
}
