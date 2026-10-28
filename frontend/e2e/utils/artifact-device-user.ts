// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process'
import { chown } from 'node:fs/promises'
import { join } from 'node:path'

/** Native agents must not inherit the Playwright container's root identity. */
export async function prepareArtifactDeviceUser(
  root: string,
  identity = { platform: process.platform, uid: process.getuid?.() }
): Promise<{
  uid?: number
  gid?: number
}> {
  if (identity.platform !== 'linux' || identity.uid !== 0) return {}

  // Use the account supplied by the Playwright image, not an assumed host UID.
  const ids = ['-u', '-g'].map(flag => {
    const value = execFileSync('id', [flag, 'pwuser'], { encoding: 'utf8' }).trim()
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) === 0)
      throw new Error(`Artifact E2E requires an unprivileged pwuser ${flag}: ${value}`)
    return Number(value)
  })
  const [uid, gid] = ids
  // These are freshly created, test-owned directories; never chown the checkout.
  await chown(root, uid, gid)
  await chown(join(root, 'home'), uid, gid)
  return { uid, gid }
}
