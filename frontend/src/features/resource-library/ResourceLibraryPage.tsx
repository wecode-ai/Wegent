// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { MyResources } from './components/MyResources'

export function ResourceLibraryPage() {
  return (
    <main className="h-full overflow-y-auto bg-base text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4">
          <div data-testid="resource-library-content">
            <MyResources />
          </div>
        </section>
      </div>
    </main>
  )
}

export default ResourceLibraryPage
