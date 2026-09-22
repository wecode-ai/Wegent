// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelEditDialog from '@/features/settings/components/ModelEditDialog'
import type { ModelCRD } from '@/apis/models'

jest.setTimeout(30000)

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.keys ? `${key}: ${options.keys}` : key,
  }),
}))

jest.mock('@/features/resource-library/useCapabilityPublicationScope', () => ({
  useCapabilityPublicationScope: () => ({
    target: 'personal',
    groupNames: [],
    writableGroups: [],
    loading: false,
    handleChange: jest.fn(),
    savePublicationScope: jest.fn(),
  }),
}))

const existingModel: ModelCRD = {
  apiVersion: 'agent.wecode.io/v1',
  kind: 'Model',
  metadata: {
    name: 'qwen-compatible',
    namespace: 'default',
    displayName: 'Qwen Compatible',
  },
  spec: {
    modelConfig: {
      env: {
        model: 'openai',
        model_id: 'qwen3.6-plus',
        api_key: 'sk-test',
        base_url: 'https://example.com/v1',
        supports_developer_role: false,
        retry_policy: { attempts: 0 },
      },
    },
    modelType: 'llm',
    protocol: 'openai',
    apiFormat: 'chat/completions',
  },
  status: { state: 'Available' },
}

describe('ModelEditDialog advanced env configuration', () => {
  it('loads and preserves unknown env fields when editing a model', async () => {
    const user = userEvent.setup()
    const onSave = jest.fn().mockResolvedValue(true)

    render(
      <ModelEditDialog
        open
        model={existingModel}
        onClose={jest.fn()}
        toast={jest.fn()}
        onSave={onSave}
      />
    )

    await user.click(screen.getByTestId('advanced-model-env-config-trigger'))
    const input = screen.getByTestId('advanced-model-env-config-input')

    expect(input).toHaveValue(
      JSON.stringify(
        {
          supports_developer_role: false,
          retry_policy: { attempts: 0 },
        },
        null,
        2
      )
    )

    fireEvent.change(input, {
      target: {
        value: JSON.stringify({
          supports_developer_role: true,
          retry_policy: { attempts: 0, enabled: false },
        }),
      },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [formData, savedModel] = onSave.mock.calls[0]
    expect(formData.advancedEnvConfig).toEqual({
      supports_developer_role: true,
      retry_policy: { attempts: 0, enabled: false },
    })
    expect(savedModel.spec.modelConfig.env).toEqual({
      supports_developer_role: true,
      retry_policy: { attempts: 0, enabled: false },
      model: 'openai',
      model_id: 'qwen3.6-plus',
      api_key: 'sk-test',
      base_url: 'https://example.com/v1',
    })
  })

  it('blocks advanced configuration from overriding form-managed fields', async () => {
    const user = userEvent.setup()
    const onSave = jest.fn().mockResolvedValue(true)

    render(
      <ModelEditDialog
        open
        model={existingModel}
        onClose={jest.fn()}
        toast={jest.fn()}
        onSave={onSave}
      />
    )

    await user.click(screen.getByTestId('advanced-model-env-config-trigger'))
    fireEvent.change(screen.getByTestId('advanced-model-env-config-input'), {
      target: { value: '{"model_id":"hidden-override"}' },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'common:models.errors.advanced_env_config_reserved_keys: model_id'
    )
    expect(screen.getByTestId('advanced-model-env-config-input')).toHaveFocus()
  })
})
