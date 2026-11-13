// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { invokeDesktopHost } from '@/api/dsh/desktopHost'

/** Exercise production consent windows concurrently without provider credentials. */
export async function verifyConnectorAuthorizationIsolation(baseUrl: string): Promise<void> {
  const ids = [crypto.randomUUID(), crypto.randomUUID()]
  try {
    for (const [index, requestId] of ids.entries()) {
      await invokeDesktopHost('auth.openConnectorAuthorization', {
        requestId,
        url: `${baseUrl}/cookie-probe?attempt=${index}`,
      })
    }
    for (const requestId of ids) {
      const state = await invokeDesktopHost<{ open: boolean }>(
        'auth.getConnectorAuthorizationState',
        { requestId }
      )
      if (!state.open) throw new Error('A concurrent consent window closed unexpectedly')
    }
  } finally {
    await Promise.all(
      ids.map(requestId => invokeDesktopHost('auth.closeConnectorAuthorization', { requestId }))
    )
  }
}
