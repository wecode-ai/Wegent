import { lstatSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

export function packagedUpdaterCache(
  home: string,
  resources: string,
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): string {
  const base =
    platform === 'darwin'
      ? join(home, 'Library', 'Caches')
      : platform === 'win32'
        ? environment.LOCALAPPDATA || join(home, 'AppData', 'Local')
        : environment.XDG_CACHE_HOME || join(home, '.cache')
  // Use the same configuration as electron-updater; branded package names differ.
  const name: unknown = parse(
    readFileSync(join(resources, 'app-update.yml'), 'utf8')
  )?.updaterCacheDirName
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*]/.test(name) ||
    Array.from(name).some(character => character.charCodeAt(0) < 32)
  )
    throw new Error('Invalid updater cache directory in app-update.yml')
  return join(base, name)
}

// Retire the bridge created by older builds, including dangling links. The
// updater creates its native cache on demand; retained cache data and obsolete
// migration journals are never startup requirements or grounds for deletion.
export function restoreNativeUpdaterCache(cache: string, desktop: string): boolean {
  let entry
  try {
    entry = lstatSync(cache)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (
    !entry.isSymbolicLink() ||
    resolve(dirname(cache), readlinkSync(cache)) !== resolve(desktop, 'updater-cache')
  )
    return false
  unlinkSync(cache)
  return true
}
