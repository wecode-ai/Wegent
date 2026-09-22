// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelEditDialog from '@/features/settings/components/ModelEditDialog'
import { modelApis, type ModelCRD } from '@/apis/models'

jest.setTimeout(30000)

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.keys ? `${key}: ${options.keys}` : key,
  }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/components/common/CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
    dataTestId,
    ariaLabel,
    ariaInvalid,
  }: {
    value: string
    onChange: (value: string) => void
    dataTestId: string
    ariaLabel: string
    ariaInvalid: boolean
  }) => (
    <textarea
      data-testid={dataTestId}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  ),
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
        api_key: 'sk-plaintext-test',
        base_url: 'https://example.com/v1',
        supports_developer_role: false,
        retry_policy: { attempts: 0 },
      },
      futureRuntime: { enabled: false },
    },
    modelType: 'llm',
    protocol: 'openai',
    apiFormat: 'chat/completions',
    futureSpecOption: { mode: 'strict' },
  },
  status: { state: 'Available' },
}

describe('ModelEditDialog model spec modes', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('defaults to the visual form and exposes plaintext secrets only after opting into JSON', async () => {
    const user = userEvent.setup()
    render(<ModelEditDialog open model={existingModel} onClose={jest.fn()} toast={jest.fn()} />)

    expect(screen.getByTestId('model-spec-form-mode-button')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('model-spec-switch-secret-warning')).toBeInTheDocument()
    expect(screen.queryByTestId('model-spec-secret-warning')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('model-spec-json-mode-button'))

    expect(screen.getByTestId('model-spec-secret-warning')).toBeInTheDocument()
    expect((screen.getByTestId('model-spec-json-editor') as HTMLTextAreaElement).value).toContain(
      'sk-plaintext-test'
    )
  })

  it('uses JSON as the sole source of truth and preserves future fields on save', async () => {
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

    await user.click(screen.getByTestId('model-spec-json-mode-button'))
    const editedSpec = {
      modelConfig: {
        env: {
          model: 'claude',
          model_id: 'expert-model',
          api_key: 'expert-secret',
          supports_developer_role: true,
        },
        futureRuntime: { enabled: true },
      },
      modelType: 'llm',
      protocol: 'anthropic',
      futureSpecOption: { mode: 'future' },
    }
    fireEvent.change(screen.getByTestId('model-spec-json-editor'), {
      target: { value: JSON.stringify(editedSpec) },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1].spec).toEqual(editedSpec)
  })

  it('preserves unknown spec, modelConfig, and env fields when saving the visual form', async () => {
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

    fireEvent.change(screen.getByLabelText('common:models.base_url'), {
      target: { value: 'https://changed.example/v1' },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const savedSpec = onSave.mock.calls[0][1].spec
    expect(savedSpec.futureSpecOption).toEqual({ mode: 'strict' })
    expect(savedSpec.modelConfig.futureRuntime).toEqual({ enabled: false })
    expect(savedSpec.modelConfig.env.supports_developer_role).toBe(false)
    expect(savedSpec.modelConfig.env.retry_policy).toEqual({ attempts: 0 })
    expect(savedSpec.modelConfig.env.base_url).toBe('https://changed.example/v1')
  })

  it('hydrates known fields when returning to the form and keeps incompatible specs in JSON', async () => {
    const user = userEvent.setup()
    render(<ModelEditDialog open model={existingModel} onClose={jest.fn()} toast={jest.fn()} />)

    await user.click(screen.getByTestId('model-spec-json-mode-button'))
    const editor = screen.getByTestId('model-spec-json-editor')
    fireEvent.change(editor, {
      target: {
        value: JSON.stringify({
          ...existingModel.spec,
          modelGroup: 'expert-group',
          modelConfig: {
            ...existingModel.spec.modelConfig,
            env: {
              ...existingModel.spec.modelConfig.env,
              base_url: 'https://json.example/v1',
            },
          },
        }),
      },
    })
    await user.click(screen.getByTestId('model-spec-form-mode-button'))
    expect(screen.getByTestId('model-group-input')).toHaveValue('expert-group')
    expect(screen.getByLabelText('common:models.base_url')).toHaveValue('https://json.example/v1')

    await user.click(screen.getByTestId('model-spec-json-mode-button'))
    fireEvent.change(screen.getByTestId('model-spec-json-editor'), {
      target: { value: JSON.stringify({ modelConfig: { futureRuntime: true } }) },
    })
    await user.click(screen.getByTestId('model-spec-form-mode-button'))
    expect(screen.getByTestId('model-spec-json-editor')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'common:models.errors.model_spec_not_form_compatible'
    )
  })

  it('blocks invalid JSON and tests or loads models with the active JSON runtime config', async () => {
    const user = userEvent.setup()
    const onSave = jest.fn().mockResolvedValue(true)
    const testConnection = jest
      .spyOn(modelApis, 'testConnection')
      .mockResolvedValue({ success: true, message: 'ok' })
    const fetchAvailableModels = jest
      .spyOn(modelApis, 'fetchAvailableModels')
      .mockResolvedValue({ success: true, models: [] })
    render(
      <ModelEditDialog
        open
        model={existingModel}
        onClose={jest.fn()}
        toast={jest.fn()}
        onSave={onSave}
      />
    )

    await user.click(screen.getByTestId('model-spec-json-mode-button'))
    const runtimeSpec = {
      modelConfig: {
        env: {
          model: 'openai',
          model_id: 'json-runtime-model',
          api_key: 'json-runtime-key',
          base_url: 'https://json-runtime.example/v1',
          custom_headers: { 'X-Test': 'json' },
        },
      },
      modelType: 'llm' as const,
      protocol: 'openai-responses',
    }
    fireEvent.change(screen.getByTestId('model-spec-json-editor'), {
      target: { value: JSON.stringify(runtimeSpec) },
    })
    await user.click(screen.getByTestId('model-spec-load-models-button'))
    await user.click(screen.getByTestId('model-test-connection-button'))

    await waitFor(() => expect(fetchAvailableModels).toHaveBeenCalledTimes(1))
    expect(fetchAvailableModels).toHaveBeenCalledWith({
      provider_type: 'openai-responses',
      api_key: 'json-runtime-key',
      base_url: 'https://json-runtime.example/v1',
      custom_headers: { 'X-Test': 'json' },
    })
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1))
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_type: 'openai-responses',
        model_id: 'json-runtime-model',
        api_key: 'json-runtime-key',
      })
    )

    fireEvent.change(screen.getByTestId('model-spec-json-editor'), {
      target: { value: '{"modelConfig":' },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /common:models.errors.model_spec_invalid_json/
    )

    fireEvent.change(screen.getByTestId('model-spec-json-editor'), {
      target: {
        value: '{"modelConfig":{"env":{"constructor":{"api_key":"must-not-appear"}}}}',
      },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /common:models.errors.model_spec_unsafe_keys/
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('must-not-appear')
  })
})
