// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AdminPublicModel } from '@/apis/admin'
import { convertAdminModelToInitialData } from '@/features/admin/components/SetupModelStep'

describe('SetupModelStep model editing', () => {
  it('preserves advanced and wrapped thinking configuration', () => {
    const model: AdminPublicModel = {
      id: 1,
      name: 'qwen-compatible',
      namespace: 'default',
      display_name: 'Qwen Compatible',
      is_active: true,
      is_visible: true,
      is_advanced: false,
      created_at: '2026-09-22T00:00:00Z',
      updated_at: '2026-09-22T00:00:00Z',
      json: {
        metadata: { displayName: 'Qwen Compatible' },
        spec: {
          modelType: 'llm',
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'qwen3.6-plus',
              thinking_config: {
                thinking_config: { effort: 'high', enabled: false },
              },
              supports_developer_role: false,
            },
          },
        },
      },
    }

    expect(convertAdminModelToInitialData(model)).toMatchObject({
      thinkingConfig: { effort: 'high', enabled: false },
      advancedEnvConfig: { supports_developer_role: false },
    })
  })
})
