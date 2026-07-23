// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getModelCapabilities, getModelCapabilitiesFromSpec } from '@/lib/model-capabilities'

describe('getModelCapabilities', () => {
  it('prefers top-level capabilities over legacy config', () => {
    expect(
      getModelCapabilities({
        modelCapabilities: { supportsImage: true, supportsVideo: false },
        config: {
          modelCapabilities: { supportsImage: false, supportsVideo: true },
        },
      })
    ).toEqual({ supportsImage: true, supportsVideo: false })
  })

  it('falls back to legacy config when top-level capabilities are absent', () => {
    expect(
      getModelCapabilities({
        config: {
          modelCapabilities: { supportsImage: true, supportsVideo: true },
        },
      })
    ).toEqual({ supportsImage: true, supportsVideo: true })
  })

  it('ignores malformed capability values', () => {
    expect(
      getModelCapabilities({
        config: {
          modelCapabilities: {
            supportsImage: 'true',
            supportsVideo: false,
          },
        },
      })
    ).toEqual({ supportsVideo: false })
  })

  it('ignores non-object legacy capability values', () => {
    expect(
      getModelCapabilities({
        config: { modelCapabilities: ['supportsImage'] },
      })
    ).toEqual({})
  })
})

describe('getModelCapabilitiesFromSpec', () => {
  it('maps legacy modelConfig capabilities for edit forms', () => {
    expect(
      getModelCapabilitiesFromSpec({
        modelConfig: {
          modelCapabilities: { supportsImage: true, supportsVideo: true },
        },
      })
    ).toEqual({ supportsImage: true, supportsVideo: true })
  })

  it('prefers canonical spec capabilities during edit migration', () => {
    expect(
      getModelCapabilitiesFromSpec({
        modelCapabilities: { supportsImage: true, supportsVideo: false },
        modelConfig: {
          modelCapabilities: { supportsImage: false, supportsVideo: true },
        },
      })
    ).toEqual({ supportsImage: true, supportsVideo: false })
  })
})
