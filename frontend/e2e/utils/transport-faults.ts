// SPDX-License-Identifier: Apache-2.0

import type { Route } from '@playwright/test'

/** Fail the browser transport, without fabricating data or issuing a second HTTP request. */
export async function failRequestTransport(route: Route): Promise<void> {
  await route.abort('failed')
}
