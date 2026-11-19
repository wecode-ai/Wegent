// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

const FLAG = 'collab.baseBoardStatusGrouping.v1'

/** Keep legacy grouping scenarios as explicit rollback coverage. */
async function beginLegacyBoardGrouping(control) {
  const previous = await control.command('getLocalStorageItem', 'body', { value: FLAG })
  await control.command('setLocalStorageItem', 'body', {
    value: JSON.stringify({ key: FLAG, value: 'false' }),
  })
  assert.equal(
    await control.command('getLocalStorageItem', 'body', { value: FLAG }),
    'false',
    'The legacy board grouping flag must be set before opening the fixture project'
  )
  return async () => {
    if (previous) {
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: FLAG, value: previous }),
      })
    } else {
      await control.command('removeLocalStorageItem', 'body', { value: FLAG })
    }
    assert.equal(
      await control.command('getLocalStorageItem', 'body', { value: FLAG }),
      previous,
      'The board grouping flag must be restored after the rollback scenario'
    )
  }
}

/** Restore renderer state before the shared runner shuts down the application. */
export function withLegacyBoardGrouping(verify) {
  return async control => {
    const restore = await beginLegacyBoardGrouping(control)
    try {
      await verify(control)
    } finally {
      await restore()
    }
  }
}
