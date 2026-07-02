// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import type React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import MobileCorrectionModeToggle from '@/features/tasks/components/MobileCorrectionModeToggle'
import MobileClarificationToggle from '@/features/tasks/components/clarification/MobileClarificationToggle'
import { correctionApis } from '@/apis/correction'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'chat:correction.label': '交叉验证',
        'correction.label': '交叉验证',
      }
      return translations[key] ?? (typeof fallback === 'string' ? fallback : key)
    },
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/model-select/ModelCascadeSelect', () => ({
  ModelCascadeContent: () => <div data-testid="model-cascade-content" />,
}))

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn().mockResolvedValue({ data: [] }),
  },
}))

jest.mock('@/apis/correction', () => ({
  correctionApis: {
    getCorrectionModeState: jest.fn(() => ({
      enabled: false,
      correctionModelId: null,
      correctionModelName: null,
      enableWebSearch: false,
    })),
    migrateCorrectionModeState: jest.fn(() => null),
    saveCorrectionModeState: jest.fn(),
    clearCorrectionModeState: jest.fn(),
  },
}))

const mockedCorrectionApis = correctionApis as jest.Mocked<typeof correctionApis>

describe('mobile toggle controls', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders clarification as one switch button without nested buttons', () => {
    const onToggle = jest.fn()

    render(<MobileClarificationToggle enabled={false} onToggle={onToggle} />)

    const toggle = screen.getByRole('switch', { name: '追问澄清' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle.querySelector('button')).toBeNull()

    fireEvent.click(toggle)

    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('renders correction mode as one switch button without nested buttons', () => {
    const onToggle = jest.fn()

    render(
      <MobileCorrectionModeToggle
        enabled
        onToggle={onToggle}
        correctionModelName="Correction model"
        taskId={null}
      />
    )
    onToggle.mockClear()

    const toggle = screen.getByRole('switch', { name: /交叉验证/ })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle.querySelector('button')).toBeNull()

    fireEvent.click(toggle)

    expect(onToggle).toHaveBeenCalledWith(false)
    expect(mockedCorrectionApis.clearCorrectionModeState).toHaveBeenCalledWith(null)
  })
})
