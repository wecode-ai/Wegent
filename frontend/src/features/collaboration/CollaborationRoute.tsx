// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Suspense } from 'react'

import { CollaborationPage } from './CollaborationPage'

export function CollaborationRoute() {
  return (
    <Suspense fallback={null}>
      <CollaborationPage />
    </Suspense>
  )
}
