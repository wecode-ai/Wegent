import { collectCleanupErrors } from './cleanup.mjs'

export async function cleanupNativeMcpResources(cleanups, failure) {
  const errors = await collectCleanupErrors(cleanups)
  if (failure !== undefined) throw failure
  const firstFailure = errors.find(error => error !== undefined)
  if (firstFailure !== undefined) throw firstFailure
}
