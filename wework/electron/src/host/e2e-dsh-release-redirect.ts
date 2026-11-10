import type { Session } from 'electron'

export function installE2eDshReleaseRedirect(webRequest: Session['webRequest'], value: string) {
  const { source, target } = JSON.parse(value)
  const original = new URL(source)
  const destination = new URL(target)
  if (
    original.origin !== 'https://github.com' ||
    original.username ||
    original.password ||
    !original.pathname.startsWith('/wecode-ai/Wegent/releases/download/wework-updater/') ||
    destination.origin !== 'https://release-assets.githubusercontent.com' ||
    destination.username ||
    destination.password
  ) {
    throw new Error('The E2E DSH redirect must use an official GitHub release asset')
  }
  webRequest.onBeforeRequest({ urls: [original.href] }, (details, callback) => {
    callback(details.url === original.href ? { redirectURL: destination.href } : {})
  })
}
