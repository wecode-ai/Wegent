// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(SCRIPT_DIR, '..')
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const FILE_VIEWER_PACKAGES = [
  { name: '@file-viewer/react', section: 'dependencies' },
  { name: '@file-viewer/preset-office', section: 'dependencies' },
  { name: 'file-viewer-copy-assets', section: 'devDependencies' },
]

export function validateFileViewerVersions({ manifest, installedVersions }) {
  const errors = []
  const declaredVersions = []

  for (const { name, section } of FILE_VIEWER_PACKAGES) {
    const declaredVersion = manifest[section]?.[name]
    const installedVersion = installedVersions[name]

    if (!EXACT_VERSION_PATTERN.test(declaredVersion ?? '')) {
      errors.push(
        `${name}: package.json must declare an exact version, received ${declaredVersion}`
      )
    } else {
      declaredVersions.push(`${name}=${declaredVersion}`)
    }

    if (!installedVersion) {
      errors.push(`${name}: package is not installed`)
    } else if (installedVersion !== declaredVersion) {
      errors.push(`${name}: installed=${installedVersion}, package.json=${declaredVersion}`)
    }
  }

  const uniqueDeclaredVersions = new Set(declaredVersions.map(entry => entry.split('=')[1]))
  if (uniqueDeclaredVersions.size > 1) {
    errors.push(`package.json versions differ: ${declaredVersions.join(', ')}`)
  }

  if (errors.length > 0) {
    throw new Error(
      `[file-viewer-assets] File Viewer runtime and asset versions must match:\n- ${errors.join('\n- ')}`
    )
  }

  return { version: uniqueDeclaredVersions.values().next().value }
}

export async function resolveFileViewerVersion(frontendDir = FRONTEND_DIR) {
  const require = createRequire(path.join(frontendDir, 'package.json'))
  const manifest = JSON.parse(await readFile(path.join(frontendDir, 'package.json'), 'utf8'))
  const installedVersions = {}

  for (const { name } of FILE_VIEWER_PACKAGES) {
    try {
      const packageJsonPath = require.resolve(`${name}/package.json`)
      installedVersions[name] = JSON.parse(await readFile(packageJsonPath, 'utf8')).version
    } catch {
      installedVersions[name] = undefined
    }
  }

  return validateFileViewerVersions({ manifest, installedVersions })
}
