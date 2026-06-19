// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import CodePage from '@/app/(tasks)/code/page'

const replace = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace,
  }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/components/RuntimeConfigInit', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

describe('legacy code page redirect', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams('taskId=42')
  })

  test('redirects to chat code-agent mode and preserves query params', async () => {
    render(<CodePage />)

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/chat?taskId=42&agent=code')
    })
  })
})
