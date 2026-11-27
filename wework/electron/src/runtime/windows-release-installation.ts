import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicReleaseWrite, optionalText, type ReleaseStore } from './release-store.js'
import { cloneReleaseProfile, currentCoreProfile, selectReleaseProfile } from './release-profile.js'

/** The marker belongs to the physical installer entry, never to an online-update slot. */
export async function pendingWindowsInstallation(
  store: ReleaseStore,
  executable: string,
  version: string,
  platform = process.platform
): Promise<string | null> {
  if (platform !== 'win32') return null
  const marker = await optionalText(join(dirname(executable), 'wework-installed-release'))
  if (!marker) return null
  const [installedVersion, token] = marker.split(/\r?\n/)
  if (installedVersion !== version) return null
  if (!token || !/^\d{15,20}$/.test(token)) throw new Error('Invalid Windows installation marker')
  if ((await optionalText(join(store.root, 'windows-installation'))) === token) return null
  return token
}

export const windowsInstallationId = (version: string, token: string): string =>
  `installed-${version}-${token}`

export async function prepareWindowsInstallationProfile(
  store: ReleaseStore,
  dataDirectory: string,
  installationId: string
): Promise<void> {
  if (await store.activation()) throw new Error('The previous update still requires recovery')
  const active = await store.active()
  if (!active || active.id === installationId) return
  const target = join(store.slot(installationId), 'profile')
  const live = currentCoreProfile(dataDirectory)
  const physicalPath = (path: string) =>
    realpath(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
  const [selected, staged] = await Promise.all([physicalPath(live), physicalPath(target)])
  if (selected && selected === staged) return
  await cloneReleaseProfile(active.profileRoot, target)
  await selectReleaseProfile(dataDirectory, target, join(store.root, 'legacy-profile'))
}

export async function acknowledgeWindowsInstallation(store: ReleaseStore, token: string) {
  await mkdir(store.root, { recursive: true, mode: 0o700 })
  await atomicReleaseWrite(join(store.root, 'windows-installation'), token)
}
