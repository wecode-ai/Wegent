import { lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Bind cleanup authority to the exact entry created by the native auth writer. */
export function writeManagedAuthMarker(home: string, ownerId?: string): void {
  try {
    const path = join(home, 'auth.json')
    const metadata = lstatSync(path, { bigint: true })
    const auth = {
      kind: metadata.isSymbolicLink() ? 'symlink' : metadata.isFile() ? 'file' : 'other',
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
      ...(metadata.isSymbolicLink() ? { target: resolve(dirname(path), readlinkSync(path)) } : {}),
    }
    writeFileSync(
      join(home, '.wework-managed-auth'),
      ownerId ? JSON.stringify({ version: 1, ownerId, auth }) : '',
      { mode: 0o600 }
    )
  } catch {
    // Missing ownership evidence must preserve auth, never broaden cleanup authority.
  }
}
