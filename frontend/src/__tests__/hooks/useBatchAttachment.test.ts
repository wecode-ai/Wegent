// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { renderHook, act } from '@testing-library/react'

import { useBatchAttachment } from '@/hooks/useBatchAttachment'
import {
  registerVideoUploader,
  getVideoUploader,
} from '@/features/knowledge/multimodal/video-upload-registry'

// Identity translator — returns the key so we can assert which error branch fired.
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Mock the attachments module, but keep the pure helpers real so the test
// exercises actual video/size classification (the logic under test).
jest.mock('@/apis/attachments', () => {
  const actual = jest.requireActual('@/apis/attachments')
  return {
    ...actual,
    uploadAttachment: jest.fn(),
    deleteAttachment: jest.fn(),
    getErrorMessageFromCode: jest.fn(),
  }
})

const MB = 1024 * 1024

function makeVideoFile(name: string, sizeMb: number): File {
  return new File([new Uint8Array(sizeMb * MB)], name, { type: 'video/mp4' })
}

function makeTextFile(name: string, sizeMb: number): File {
  return new File([new Uint8Array(sizeMb * MB)], name, { type: 'text/plain' })
}

describe('useBatchAttachment — KB video queue gate', () => {
  afterEach(() => {
    // Reset provider registry between tests for isolation.
    registerVideoUploader(null)
  })

  it('rejects a video when no provider is registered (open-source default)', () => {
    const { result } = renderHook(() => useBatchAttachment())

    let outcome: { added: number; rejected: number; reason?: string } | undefined
    act(() => {
      outcome = result.current.addFiles([makeVideoFile('clip.mp4', 10)])
    })

    expect(outcome!.added).toBe(0)
    expect(outcome!.rejected).toBe(1)
    // The "no provider" branch must fire, NOT the generic size-too-large branch.
    expect(outcome!.reason).toContain('video_upload_unavailable')
    expect(result.current.state.files).toHaveLength(0)
  })

  it('rejects a video that exceeds the provider-declared ceiling', () => {
    // Provider accepts up to 300 MB.
    registerVideoUploader({ upload: jest.fn(), maxSizeBytes: 300 * MB })
    expect(getVideoUploader()).not.toBeNull()

    const { result } = renderHook(() => useBatchAttachment())

    let outcome: { added: number; rejected: number; reason?: string } | undefined
    act(() => {
      // 500 MB > 300 MB ceiling → must be rejected by the provider gate.
      outcome = result.current.addFiles([makeVideoFile('big.mp4', 500)])
    })

    expect(outcome!.added).toBe(0)
    expect(outcome!.rejected).toBe(1)
    expect(outcome!.reason).toContain('file_too_large')
    expect(result.current.state.files).toHaveLength(0)
  })

  it('admits a video within the provider ceiling (regression: was blocked by 100 MB generic cap)', () => {
    // This is the bug scenario: provider wired, file between 100 MB and the
    // provider ceiling. Before the fix it hit the generic isValidFileSize gate.
    registerVideoUploader({ upload: jest.fn(), maxSizeBytes: 1024 * 1024 * 1024 })

    const { result } = renderHook(() => useBatchAttachment())

    let outcome: { added: number; rejected: number; reason?: string } | undefined
    act(() => {
      outcome = result.current.addFiles([makeVideoFile('clip.mp4', 500)])
    })

    expect(outcome!.added).toBe(1)
    expect(outcome!.rejected).toBe(0)
    expect(outcome!.reason).toBeUndefined()
    expect(result.current.state.files).toHaveLength(1)
  })

  it('admits a small video that also fits the generic cap', () => {
    registerVideoUploader({ upload: jest.fn(), maxSizeBytes: 1024 * MB })

    const { result } = renderHook(() => useBatchAttachment())

    let outcome: { added: number; rejected: number; reason?: string } | undefined
    act(() => {
      outcome = result.current.addFiles([makeVideoFile('small.mp4', 50)])
    })

    expect(outcome!.added).toBe(1)
    expect(result.current.state.files).toHaveLength(1)
  })

  it('keeps the generic 100 MB cap for non-video files regardless of provider', () => {
    registerVideoUploader({ upload: jest.fn(), maxSizeBytes: 1024 * MB })

    const { result } = renderHook(() => useBatchAttachment())

    let outcome: { added: number; rejected: number; reason?: string } | undefined
    act(() => {
      // A text file > 100 MB must still be rejected by the generic cap.
      outcome = result.current.addFiles([makeTextFile('doc.txt', 150)])
    })

    expect(outcome!.added).toBe(0)
    expect(outcome!.rejected).toBe(1)
    expect(outcome!.reason).toContain('file_too_large')
    expect(result.current.state.files).toHaveLength(0)
  })

  it('admits a non-video file within the generic cap even with a provider present', () => {
    registerVideoUploader({ upload: jest.fn(), maxSizeBytes: 1024 * MB })

    const { result } = renderHook(() => useBatchAttachment())

    let outcome: { added: number; rejected: number; reason?: string } | undefined
    act(() => {
      outcome = result.current.addFiles([makeTextFile('doc.txt', 50)])
    })

    expect(outcome!.added).toBe(1)
    expect(result.current.state.files).toHaveLength(1)
  })
})
