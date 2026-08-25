import type { CloudAuthorizationHandle } from '@/features/cloud-connection/CloudConnectionContext'
import { isHttpUrl, openExternalUrl } from './external-links'

export async function openCloudAuthorizationWindow(
  url: string
): Promise<CloudAuthorizationHandle | void> {
  if (!isHttpUrl(url)) {
    return
  }

  await openExternalUrl(url)
}
