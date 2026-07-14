// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { resolveEffectivePrompt } from './resolveMultimodalPrompt'
import type { MultimodalDefaultPrompts } from '@/apis/knowledge'

const DEFAULTS: MultimodalDefaultPrompts = {
  enabled: true,
  video_prompt: 'SYS_VIDEO',
  image_prompt: 'SYS_IMAGE',
}

describe('resolveEffectivePrompt (3-layer precedence)', () => {
  it('prefers the document override over KB default and system default', () => {
    const r = resolveEffectivePrompt('video', 'doc override', 'kb default', DEFAULTS)
    expect(r.text).toBe('doc override')
    expect(r.source).toBe('document')
    expect(r.customized).toBe(true)
  })

  it('falls back to the KB default when no document override', () => {
    const r = resolveEffectivePrompt('video', null, 'kb default', DEFAULTS)
    expect(r.text).toBe('kb default')
    expect(r.source).toBe('knowledge')
    expect(r.customized).toBe(true)
  })

  it('falls back to the system default when neither doc nor KB is set', () => {
    const r = resolveEffectivePrompt('image', null, null, DEFAULTS)
    expect(r.text).toBe('SYS_IMAGE')
    expect(r.source).toBe('system')
    expect(r.customized).toBe(false)
  })

  it('treats blank/whitespace overrides as absent (falls through)', () => {
    expect(resolveEffectivePrompt('video', '   ', 'kb', DEFAULTS).source).toBe('knowledge')
    expect(resolveEffectivePrompt('video', '', null, DEFAULTS).source).toBe('system')
    // blank KB prompt with no doc → system
    expect(resolveEffectivePrompt('image', undefined, '  ', DEFAULTS).source).toBe('system')
  })

  it('selects the system default for the requested media type', () => {
    expect(resolveEffectivePrompt('video', null, null, DEFAULTS).text).toBe('SYS_VIDEO')
    expect(resolveEffectivePrompt('image', null, null, DEFAULTS).text).toBe('SYS_IMAGE')
  })
})
