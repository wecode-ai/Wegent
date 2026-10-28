import { HostCapabilityError } from './capability-router.js'

/** Business credentials are reachable only through their dedicated host services. */
export function publicCredentialKey(params: Record<string, unknown>): string {
  const key = params.key
  if (
    typeof key !== 'string' ||
    /^(wework-model-key\.|wework-models\.|wework-cloud\.|wework-mirrors\.)/.test(key)
  ) {
    throw new HostCapabilityError('capability_denied', 'This credential namespace is private')
  }
  return key
}
