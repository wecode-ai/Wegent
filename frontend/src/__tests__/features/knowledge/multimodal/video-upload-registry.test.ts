// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  registerVideoUploader,
  getVideoUploader,
} from '@/features/knowledge/multimodal/video-upload-registry'

function makeUploader(maxSizeBytes: number) {
  return {
    upload: jest.fn(),
    maxSizeBytes,
  }
}

describe('video-upload-registry', () => {
  afterEach(() => {
    // Clear any provider registered during a test so cases stay isolated.
    registerVideoUploader(null)
  })

  it('returns null by default (open-source has no provider)', () => {
    expect(getVideoUploader()).toBeNull()
  })

  it('returns the registered uploader with its declared size ceiling', () => {
    const uploader = makeUploader(1024 * 1024 * 1024)
    registerVideoUploader(uploader)

    const current = getVideoUploader()
    expect(current).not.toBeNull()
    expect(current).toBe(uploader)
    expect(current!.maxSizeBytes).toBe(1024 * 1024 * 1024)
  })

  it('exposes the upload function separately from the size ceiling', () => {
    const upload = jest.fn()
    registerVideoUploader({ upload, maxSizeBytes: 500 * 1024 * 1024 })

    const current = getVideoUploader()
    expect(current).not.toBeNull()
    expect(typeof current!.upload).toBe('function')
    expect(current!.maxSizeBytes).toBe(500 * 1024 * 1024)
  })

  it('clears the uploader when null is registered', () => {
    registerVideoUploader(makeUploader(1024))
    expect(getVideoUploader()).not.toBeNull()

    registerVideoUploader(null)
    expect(getVideoUploader()).toBeNull()
  })

  it('replaces a previously registered uploader', () => {
    const first = makeUploader(100)
    const second = makeUploader(200)
    registerVideoUploader(first)
    registerVideoUploader(second)

    expect(getVideoUploader()).toBe(second)
    expect(getVideoUploader()!.maxSizeBytes).toBe(200)
  })
})
