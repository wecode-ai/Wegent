// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  extractAdvancedModelEnv,
  formatAdvancedModelEnv,
  validateAdvancedModelEnv,
} from '@/features/settings/components/model-config'

describe('advanced model env configuration', () => {
  it('extracts only fields not managed by the model form', () => {
    expect(
      extractAdvancedModelEnv({
        model: 'openai',
        model_id: 'qwen3.6-plus',
        api_key: 'secret',
        base_url: 'https://example.com/v1',
        custom_headers: { 'X-Test': 'value' },
        thinking_config: { effort: 'high' },
        supports_developer_role: false,
        retry_policy: { attempts: 0 },
      })
    ).toEqual({
      supports_developer_role: false,
      retry_policy: { attempts: 0 },
    })
  })

  it('preserves falsy and nested values during validation and formatting', () => {
    const value = {
      supports_developer_role: false,
      temperature: 0,
      provider_label: '',
      retry_policy: { enabled: false, delays: [0, 1] },
    }

    const formatted = formatAdvancedModelEnv(value)
    expect(validateAdvancedModelEnv(formatted)).toEqual({
      value,
      error: null,
      keys: [],
    })
  })

  it.each([
    ['not-json', 'invalid_json'],
    ['[]', 'invalid_object'],
    ['null', 'invalid_object'],
  ])('rejects invalid advanced configuration %s', (value, error) => {
    expect(validateAdvancedModelEnv(value)).toMatchObject({ value: null, error })
  })

  it('rejects fields managed by the structured form', () => {
    expect(validateAdvancedModelEnv('{"model_id":"hidden-override"}')).toEqual({
      value: null,
      error: 'reserved_keys',
      keys: ['model_id'],
    })
  })

  it('rejects unsafe object keys', () => {
    expect(validateAdvancedModelEnv('{"__proto__":{"polluted":true}}')).toEqual({
      value: null,
      error: 'unsafe_keys',
      keys: ['__proto__'],
    })
  })
})
