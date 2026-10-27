import * as filesystem from 'node:fs'
import { createRequire } from 'node:module'

// Update payloads contain ASAR archives as physical files, including inside Electron.
export const physicalFilesystem: typeof filesystem = process.versions.electron
  ? (createRequire(import.meta.url)('original-fs') as typeof filesystem)
  : filesystem
