// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelEditDialog from '@/features/settings/components/ModelEditDialog'
import { modelApis, type ModelCRD, type UnifiedModel } from '@/apis/models'

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
    capability: 'Fast responses for everyday questions',
    futureSpecOption: { mode: 'strict' },
  },
  status: { state: 'Available' },
}

describe('ModelEditDialog model spec modes', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('supports keyboard focus and scrolling model options while keeping the dialog locked', async () => {
    const user = userEvent.setup()
    const onClose = jest.fn()
    const onSave = jest.fn().mockResolvedValue(true)
    render(<ModelEditDialog open onClose={onClose} toast={jest.fn()} onSave={onSave} />)
    const dialog = screen.getByRole('dialog', { name: 'common:models.create_title' })
    const modelIdSelect = within(dialog).getByTestId('model-id-select')
    for (let step = 0; step < 20 && document.activeElement !== modelIdSelect; step += 1) {
      await user.tab()
    }
    expect(modelIdSelect).toHaveFocus()
    await user.keyboard('{Enter}')
    const picker = await screen.findByRole('dialog', { name: 'common:models.model_id' })
    const modelOption = within(picker).getByRole('button', { name: 'gpt-4o (Recommended)' })
    const search = within(picker).getByPlaceholderText('common:models.search_model_id')
    expect(search).toHaveFocus()
    const viewport = modelOption.parentElement!

    // JSDOM has no layout; supply only the viewport bounds read by real RemoveScroll.
    Object.defineProperties(viewport, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 600 },
    })
    viewport.scrollTop = 100

    const wheel = createEvent.wheel(modelOption, { deltaY: 40, cancelable: true })
    fireEvent(modelOption, wheel)

    fireEvent.touchStart(viewport, {
      touches: [{ clientX: 0, clientY: 100 }],
      changedTouches: [{ clientX: 0, clientY: 100 }],
    })
    const touchMove = createEvent.touchMove(viewport, {
      touches: [{ clientX: 0, clientY: 60 }],
      changedTouches: [{ clientX: 0, clientY: 60 }],
      cancelable: true,
    })
    fireEvent(viewport, touchMove)
    expect({ wheel: wheel.defaultPrevented, touchMove: touchMove.defaultPrevented }).toEqual({
      wheel: false,
      touchMove: false,
    })

    const outsideWheel = createEvent.wheel(dialog, { deltaY: 40, cancelable: true })
    fireEvent(dialog, outsideWheel)
    expect(outsideWheel.defaultPrevented).toBe(true)

    await user.keyboard('gpt-4o')
    expect(search).toHaveValue('gpt-4o')
    expect(search).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(modelIdSelect).toHaveFocus())
    expect(modelIdSelect).toHaveAttribute('aria-expanded', 'false')

    await user.keyboard(' ')
    expect(await screen.findByPlaceholderText('common:models.search_model_id')).toHaveFocus()
    const presetOption = screen.getByRole('button', { name: 'gpt-4o (Recommended)' })
    await user.tab()
    expect(presetOption).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(modelIdSelect).toHaveFocus())
    expect(modelIdSelect).toHaveTextContent('gpt-4o (Recommended)')
    expect(modelIdSelect).toHaveAttribute('aria-expanded', 'false')

    await user.keyboard(' ')
    const customSearch = await screen.findByPlaceholderText('common:models.search_model_id')
    expect(customSearch).toHaveFocus()
    expect(customSearch).toHaveValue('')
    await user.keyboard('Custom')
    const customOption = screen.getByRole('button', { name: 'Custom...' })
    await user.tab()
    expect(customOption).toHaveFocus()
    await user.keyboard(' ')
    await waitFor(() => expect(modelIdSelect).toHaveFocus())
    expect(modelIdSelect).toHaveTextContent('Custom...')
    expect(modelIdSelect).toHaveAttribute('aria-expanded', 'false')
    const customModelId = within(dialog).getByPlaceholderText(
      'common:models.custom_model_id_placeholder'
    )
    await user.tab()
    expect(customModelId).toHaveFocus()
    await user.keyboard('keyboard-custom-model')
    expect(customModelId).toHaveValue('keyboard-custom-model')
    expect(onClose).not.toHaveBeenCalled()

    await user.type(within(dialog).getByTestId('model-id-name-input'), 'keyboard-model')
    await user.type(within(dialog).getByLabelText(/common:models.api_key/), 'test-api-key')
    await user.click(within(dialog).getByRole('button', { name: 'common:actions.save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1]).toMatchObject({
      metadata: { name: 'keyboard-model' },
      spec: { modelConfig: { env: { model_id: 'keyboard-custom-model' } } },
    })
  })

  it('creates a model with a vision sidecar using options outside the scrolling dialog', async () => {
    const user = userEvent.setup()
    const onSave = jest.fn().mockResolvedValue(true)
    const sidecar: UnifiedModel = {
      name: 'vision-model',
      displayName: 'Vision Sidecar',
      type: 'user',
      namespace: 'default',
      resourceUserId: 42,
      runtime: { family: 'claude' },
      modelCapabilities: { supportsImage: true },
    }
    jest.spyOn(modelApis, 'getUnifiedModels').mockResolvedValue({ data: [sidecar] })
    render(<ModelEditDialog open onClose={jest.fn()} toast={jest.fn()} onSave={onSave} />)
    const dialog = screen.getByRole('dialog', { name: 'common:models.create_title' })

    await user.click(within(dialog).getByTestId('model-wework-available-switch'))
    const sidecarSelect = within(dialog).getByTestId('vision-sidecar-model-select')
    await waitFor(() => expect(sidecarSelect).toBeEnabled())
    await user.click(sidecarSelect)
    await user.click(await screen.findByRole('option', { name: 'Vision Sidecar' }))
    await user.type(within(dialog).getByTestId('model-id-name-input'), 'primary-model')
    const modelIdSelect = within(dialog).getByTestId('model-id-select')
    await user.click(modelIdSelect)
    const modelOption = await screen.findByText('gpt-4o (Recommended)', { exact: true })

    expect(dialog).not.toContainElement(modelOption)
    await user.click(modelOption)
    expect(modelIdSelect).toHaveTextContent('gpt-4o (Recommended)')
    expect(modelIdSelect).toHaveAttribute('aria-expanded', 'false')
    await user.type(within(dialog).getByLabelText(/common:models.api_key/), 'test-api-key')
    await user.click(within(dialog).getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1]).toMatchObject({
      metadata: { name: 'primary-model' },
      spec: {
        isWeworkAvailable: true,
        modelConfig: {
          env: { model_id: 'gpt-4o', api_key: 'test-api-key' },
          visionSidecarModel: {
            modelName: 'vision-model',
            modelType: 'user',
            namespace: 'default',
            resourceUserId: 42,
            apiFormat: 'anthropic-messages',
          },
        },
      },
    })
  })

  it.each(['systemone', 'openai'])(
    'preserves decision protocol %s without introducing a chat apiFormat',
    async protocol => {
      const user = userEvent.setup()
      const onSave = jest.fn().mockResolvedValue(true)
      const model: ModelCRD = {
        ...existingModel,
        spec: {
          modelType: 'decision',
          protocol,
          isWeworkAvailable: true,
          modelConfig: {
            env: {
              model: protocol,
              model_id: 'decision-provider-model',
              api_key: 'decision-test-key',
              base_url: 'https://decision.example/v1',
            },
          },
        },
      }
      render(
        <ModelEditDialog open model={model} onClose={jest.fn()} toast={jest.fn()} onSave={onSave} />
      )
      expect(screen.getByTestId('model-category-select')).toHaveTextContent(
        'models.model_category_type_decision'
      )
      expect(screen.getByTestId('model-protocol-select')).toHaveTextContent(
        protocol === 'systemone' ? 'SystemOne' : 'OpenAI Decisions'
      )
      await user.click(screen.getByTestId('model-spec-json-mode-button'))
      expect(
        JSON.parse((screen.getByTestId('model-spec-json-editor') as HTMLTextAreaElement).value)
          .protocol
      ).toBe(protocol)
      await user.click(screen.getByTestId('model-spec-form-mode-button'))
      await user.click(screen.getByRole('button', { name: 'common:actions.save' }))
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      expect(onSave.mock.calls[0][1].spec).toMatchObject({
        modelType: 'decision',
        protocol,
        isWeworkAvailable: true,
        modelConfig: { env: { model_id: 'decision-provider-model' } },
      })
      expect(onSave.mock.calls[0][1].spec).not.toHaveProperty('apiFormat')
    }
  )

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
    expect(screen.getByTestId('model-capability-input')).toHaveValue(
      'Fast responses for everyday questions'
    )
    fireEvent.change(screen.getByTestId('model-capability-input'), {
      target: { value: '  Strong reasoning for complex tasks  ' },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const savedSpec = onSave.mock.calls[0][1].spec
    expect(savedSpec.futureSpecOption).toEqual({ mode: 'strict' })
    expect(savedSpec.modelConfig.futureRuntime).toEqual({ enabled: false })
    expect(savedSpec.modelConfig.env.supports_developer_role).toBe(false)
    expect(savedSpec.modelConfig.env.retry_policy).toEqual({ attempts: 0 })
    expect(savedSpec.modelConfig.env.base_url).toBe('https://changed.example/v1')
    expect(savedSpec.capability).toBe('Strong reasoning for complex tasks')
  })

  it('removes a cleared capability description when saving the form', async () => {
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

    fireEvent.change(screen.getByTestId('model-capability-input'), { target: { value: '   ' } })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1].spec).not.toHaveProperty('capability')
  })

  it('edits a published model description without overwriting publication settings', async () => {
    const user = userEvent.setup()
    const onSave = jest.fn().mockResolvedValue(true)
    const publication = {
      description: 'Published capabilities',
      publishStatus: 'published',
      visibility: 'public',
      version: '1.0.0',
      allowPersonalInstall: true,
    }
    render(
      <ModelEditDialog
        open
        model={{ ...existingModel, spec: { ...existingModel.spec, capability: publication } }}
        onClose={jest.fn()}
        toast={jest.fn()}
        onSave={onSave}
      />
    )

    expect(screen.getByTestId('model-capability-input')).toHaveValue('Published capabilities')
    fireEvent.change(screen.getByTestId('model-capability-input'), {
      target: { value: 'Updated published capabilities' },
    })
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1].spec.capability).toEqual({
      ...publication,
      description: 'Updated published capabilities',
    })
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
          capability: 'Capability edited in JSON',
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
    expect(screen.getByTestId('model-capability-input')).toHaveValue('Capability edited in JSON')
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
