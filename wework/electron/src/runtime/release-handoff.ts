import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ReleaseStore } from './release-store.js'

/** Resolve only a bridge owned by the selected release or its pending source. */
export async function releaseBridgeUserData(
  store: ReleaseStore,
  executable: string,
  dataDirectory: string
): Promise<string | null> {
  const active = await store.active()
  const activation = await store.activation()
  for (const id of new Set([active?.id, activation?.from])) {
    if (!id) continue
    const release = await store.read(id)
    if (resolve(release.executable) !== resolve(executable)) continue
    if ((await realpath(store.root)) !== (await realpath(join(dataDirectory, 'releases'))))
      throw new Error('Recovery bridge user data does not own the release store')
    return dataDirectory
  }
  return null
}
