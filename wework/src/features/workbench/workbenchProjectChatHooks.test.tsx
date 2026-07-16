import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useWorkbenchModels } from './useWorkbenchModels'
import { useWorkbenchSkills } from './useWorkbenchSkills'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import type { Attachment, UnifiedModel, UnifiedSkill } from '@/types/api'

describe('workbench project chat hooks', () => {
  test('loads models and ignores model changes when locked', async () => {
    const model: UnifiedModel = { name: 'wecode-claude-sonnet-4-5', type: 'user' }
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [model] }),
    }

    const { result, rerender } = renderHook(
      ({ locked }: { locked: boolean }) => useWorkbenchModels({ api, locked }),
      { initialProps: { locked: false } }
    )

    await waitFor(() => expect(result.current.models).toEqual([model]))

    act(() => result.current.setSelectedModel(model))
    expect(result.current.selectedModel).toEqual(model)
    expect(result.current.selectedModelOptions).toEqual({})

    rerender({ locked: true })
    act(() => result.current.setSelectedModel(null))

    expect(result.current.selectedModel).toEqual(model)
  })

  test('keeps known and uncategorized coding model families', async () => {
    const claudeModel: UnifiedModel = { name: 'wecode-claude-sonnet-4-5', type: 'public' }
    const gptModel: UnifiedModel = { name: 'wecode-gpt-4.1', type: 'public' }
    const unknownModel: UnifiedModel = { name: 'unknown-model', type: 'public' }
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [claudeModel, gptModel, unknownModel] }),
    }

    const { result } = renderHook(() => useWorkbenchModels({ api, locked: false }))

    await waitFor(() =>
      expect(result.current.models).toEqual([claudeModel, gptModel, unknownModel])
    )
  })

  test('reloads models after local model settings change', async () => {
    const codexModel: UnifiedModel = {
      name: 'codex-runtime',
      type: 'runtime',
      displayName: '本机 Codex',
      runtime: { family: 'openai.openai-responses', provider: 'local' },
    }
    const localModel: UnifiedModel = {
      name: 'local-model:ollama',
      type: 'runtime',
      displayName: 'Ollama',
      runtime: { family: 'openai.openai-responses', provider: 'local' },
    }
    const api = {
      listModels: vi
        .fn()
        .mockResolvedValueOnce({ data: [codexModel] })
        .mockResolvedValueOnce({ data: [codexModel, localModel] }),
    }

    const { result } = renderHook(() => useWorkbenchModels({ api, locked: false }))

    await waitFor(() => expect(result.current.models).toEqual([codexModel]))

    act(() => {
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    })

    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.models).toEqual([codexModel, localModel]))
  })

  test('marks incompatible existing task model choices as disabled', async () => {
    const currentClaudeModel: UnifiedModel = {
      name: 'wecode-claude-sonnet-4-5',
      type: 'public',
      runtime: { family: 'claude.claude' },
    }
    const nextClaudeCompatibleModel: UnifiedModel = {
      name: 'ali-deepseek-v4-flash',
      type: 'public',
      modelId: 'deepseek-v4-flash',
      runtime: { family: 'claude.claude' },
    }
    const claudeCompatibleKimi: UnifiedModel = {
      name: 'kimi-k2.5(内网)',
      type: 'public',
      displayName: '内网:Kimi-K2.5',
      modelId: 'kimi-k2.5',
      runtime: { family: 'claude.claude' },
    }
    const gptModel: UnifiedModel = {
      name: 'gpt-5.5-medium',
      type: 'user',
      runtime: { family: 'openai.openai-responses' },
    }
    const unknownModel: UnifiedModel = {
      name: 'custom-routing-model',
      type: 'user',
    }
    const api = {
      listModels: vi.fn().mockResolvedValue({
        data: [
          currentClaudeModel,
          nextClaudeCompatibleModel,
          claudeCompatibleKimi,
          gptModel,
          unknownModel,
        ],
      }),
    }

    const { result } = renderHook(() =>
      useWorkbenchModels({
        api,
        locked: false,
        selectionConfig: {
          modelName: 'wecode-claude-sonnet-4-5',
          modelType: 'public',
        },
        compatibilityConfig: {
          modelName: 'wecode-claude-sonnet-4-5',
          modelType: 'public',
        },
      })
    )

    await waitFor(() =>
      expect(result.current.models.map(model => model.name)).toEqual([
        'wecode-claude-sonnet-4-5',
        'ali-deepseek-v4-flash',
        'kimi-k2.5(内网)',
        'gpt-5.5-medium',
        'custom-routing-model',
      ])
    )
    expect(
      result.current.models
        .filter(model => model.compatibilityDisabled)
        .map(model => [model.name, model.compatibilityDisabledReason])
    ).toEqual([
      ['gpt-5.5-medium', 'runtime_family_mismatch'],
      ['custom-routing-model', 'missing_target_runtime_family'],
    ])
  })

  test('disables Claude-compatible Kimi models for an OpenAI current task', async () => {
    const currentGptModel: UnifiedModel = {
      name: 'wecode-gpt-5.5(海外)',
      type: 'public',
      displayName: '海外:GPT5.5',
      runtime: { family: 'openai.openai-responses' },
    }
    const nextGptModel: UnifiedModel = {
      name: 'wecode-gpt-5.4(海外)',
      type: 'public',
      displayName: '海外:GPT5.4',
      runtime: { family: 'openai.openai-responses' },
    }
    const claudeCompatibleKimi: UnifiedModel = {
      name: 'kimi-k2.5(内网)',
      type: 'public',
      displayName: '内网:Kimi-K2.5',
      runtime: { family: 'claude.claude' },
    }
    const unknownDeepseek: UnifiedModel = {
      name: 'deepseek-without-env-model',
      type: 'public',
      displayName: 'DeepSeek Without env.model',
    }
    const api = {
      listModels: vi.fn().mockResolvedValue({
        data: [currentGptModel, nextGptModel, claudeCompatibleKimi, unknownDeepseek],
      }),
    }

    const { result } = renderHook(() =>
      useWorkbenchModels({
        api,
        locked: false,
        selectionConfig: {
          modelName: 'wecode-gpt-5.5(海外)',
          modelType: 'public',
        },
        compatibilityConfig: {
          modelName: 'wecode-gpt-5.5(海外)',
          modelType: 'public',
        },
      })
    )

    await waitFor(() =>
      expect(result.current.models.map(model => model.name)).toEqual([
        'wecode-gpt-5.5(海外)',
        'wecode-gpt-5.4(海外)',
        'kimi-k2.5(内网)',
        'deepseek-without-env-model',
      ])
    )
    expect(
      result.current.models
        .filter(model => model.compatibilityDisabled)
        .map(model => [model.name, model.compatibilityDisabledReason])
    ).toEqual([
      ['kimi-k2.5(内网)', 'runtime_family_mismatch'],
      ['deepseek-without-env-model', 'missing_target_runtime_family'],
    ])
  })

  test('restores model selection config and emits user changes', async () => {
    const claudeModel: UnifiedModel = { name: 'wecode-claude-sonnet-4-5', type: 'public' }
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.4',
      type: 'user',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.4',
          sortOrder: 10,
        },
      },
    }
    const onSelectionChange = vi.fn()
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [claudeModel, gptModel] }),
    }

    const { result } = renderHook(() =>
      useWorkbenchModels({
        api,
        locked: false,
        selectionConfig: {
          modelName: 'overseas-gpt-5.4',
          modelType: 'user',
          options: { reasoning: 'medium' },
        },
        onSelectionChange,
      })
    )

    await waitFor(() => expect(result.current.selectedModel).toEqual(gptModel))
    expect(result.current.selectedModelOptions).toEqual({ reasoning: 'medium' })

    act(() => result.current.setSelectedModelOption('reasoning', 'high'))

    expect(onSelectionChange).toHaveBeenCalledWith({
      modelName: 'overseas-gpt-5.4',
      modelType: 'user',
      options: { reasoning: 'high' },
    })
  })

  test('updates the model and power setting atomically', async () => {
    const solModel: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      config: {
        ui: {
          family: 'codex-official',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          controls: ['speed'],
        },
      },
    }
    const terraModel: UnifiedModel = {
      name: 'gpt-5.6-terra',
      type: 'runtime',
      config: {
        ui: {
          family: 'codex-official',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          controls: ['speed'],
        },
      },
    }
    const onSelectionChange = vi.fn()
    const api = { listModels: vi.fn().mockResolvedValue({ data: [solModel, terraModel] }) }
    const { result } = renderHook(() =>
      useWorkbenchModels({
        api,
        locked: false,
        selectionConfig: {
          modelName: solModel.name,
          modelType: solModel.type,
          options: { reasoning: 'high', speed: 'standard' },
        },
        onSelectionChange,
      })
    )

    await waitFor(() => expect(result.current.selectedModel).toEqual(solModel))
    act(() =>
      result.current.setSelectedModelAndOptions(terraModel, {
        reasoning: 'low',
        speed: 'standard',
      })
    )

    expect(result.current.selectedModel).toEqual(terraModel)
    expect(result.current.selectedModelOptions).toEqual({
      reasoning: 'low',
      speed: 'standard',
    })
    expect(onSelectionChange).toHaveBeenCalledWith({
      modelName: terraModel.name,
      modelType: terraModel.type,
      options: { reasoning: 'low', speed: 'standard' },
    })
  })

  test('copies the selected model into a new runtime task scope', async () => {
    const gptModel: UnifiedModel = {
      name: 'gpt-5.5',
      type: 'public',
      runtime: { family: 'openai.openai-responses' },
    }
    const customModel: UnifiedModel = {
      name: 'mimo-v2.5-pro',
      type: 'runtime',
      config: {
        ui: {
          family: 'gpt',
          modelLabel: 'mimo-v2.5-pro',
          sortOrder: 20,
        },
      },
      runtime: { family: 'openai.openai-responses', provider: 'local' },
    }
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [gptModel, customModel] }),
    }

    const { result, rerender } = renderHook(
      ({ scopeKey }: { scopeKey: string }) =>
        useWorkbenchModels({
          api,
          locked: false,
          scopeKey,
          persistSelection: false,
          defaultSelectionConfig: () => ({
            modelName: 'gpt-5.5',
            modelType: 'public',
            options: { reasoning: 'ultra' },
          }),
        }),
      { initialProps: { scopeKey: 'blank:1' } }
    )

    await waitFor(() => expect(result.current.selectedModel).toEqual(gptModel))

    act(() => result.current.setSelectedModel(customModel))
    act(() =>
      result.current.setSelectionForScope('runtime:local-device:task-1', customModel, {
        reasoning: 'high',
      })
    )

    rerender({ scopeKey: 'runtime:local-device:task-1' })

    expect(result.current.selectedModel).toEqual(customModel)
    expect(result.current.selectedModelOptions).toEqual({ reasoning: 'high' })
  })

  test('waits for selection readiness before restoring configured model', async () => {
    const claudeModel: UnifiedModel = { name: 'wecode-claude-sonnet-4-5', type: 'public' }
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.4',
      type: 'user',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.4',
          sortOrder: 10,
        },
      },
    }
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [claudeModel, gptModel] }),
    }
    const selectionConfig = {
      modelName: 'overseas-gpt-5.4',
      modelType: 'user' as const,
      options: { reasoning: 'high' },
    }

    const { result, rerender } = renderHook(
      ({ selectionReady }: { selectionReady: boolean }) =>
        useWorkbenchModels({
          api,
          locked: false,
          selectionConfig,
          selectionReady,
        }),
      { initialProps: { selectionReady: false } }
    )

    await waitFor(() => expect(result.current.models).toEqual([claudeModel, gptModel]))
    expect(result.current.selectedModel).toBeNull()
    expect(result.current.selectedModelOptions).toEqual({})

    rerender({ selectionReady: true })

    await waitFor(() => expect(result.current.selectedModel).toEqual(gptModel))
    expect(result.current.selectedModelOptions).toEqual({ reasoning: 'high' })
  })

  test('does not auto-select the first model without saved selection config', async () => {
    const claudeModel: UnifiedModel = { name: 'wecode-claude-sonnet-4-5', type: 'public' }
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [claudeModel] }),
    }

    const { result } = renderHook(() => useWorkbenchModels({ api, locked: false }))

    await waitFor(() => expect(result.current.models).toEqual([claudeModel]))
    expect(result.current.selectedModel).toBeNull()
    expect(result.current.selectedModelOptions).toEqual({})
  })

  test('persists options when using the default model selection', async () => {
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.4',
      type: 'user',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.4',
          sortOrder: 10,
        },
      },
    }
    const onSelectionChange = vi.fn()
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [gptModel] }),
    }

    const { result } = renderHook(() =>
      useWorkbenchModels({
        api,
        locked: false,
        selectionConfig: {
          modelName: '',
          modelType: null,
          options: { collaborationMode: 'plan' },
        },
        onSelectionChange,
      })
    )

    await waitFor(() => expect(result.current.models).toEqual([gptModel]))
    await waitFor(() =>
      expect(result.current.selectedModelOptions).toEqual({ collaborationMode: 'plan' })
    )
    expect(result.current.selectedModel).toBeNull()

    act(() => result.current.setSelectedModelOption('collaborationMode', 'default'))

    expect(onSelectionChange).toHaveBeenCalledWith({
      modelName: '',
      modelType: null,
      options: { collaborationMode: 'default' },
    })
  })

  test('loads skills and ignores skill changes when locked', async () => {
    const skill: UnifiedSkill = {
      id: 1,
      name: 'project-summary',
      namespace: 'default',
      description: 'Summarize project context',
      is_active: true,
      is_public: false,
      user_id: 1,
    }
    const api = {
      listSkills: vi.fn().mockResolvedValue([skill]),
      getTeamSkills: vi.fn().mockResolvedValue({
        skills: ['project-summary'],
        preload_skills: [],
      }),
    }

    const { result, rerender } = renderHook(
      ({ locked }: { locked: boolean }) => useWorkbenchSkills({ api, teamId: 2, locked }),
      { initialProps: { locked: false } }
    )

    await waitFor(() => expect(result.current.skills).toEqual([skill]))

    act(() =>
      result.current.toggleSkill({
        name: 'project-summary',
        namespace: 'default',
        is_public: false,
      })
    )
    expect(result.current.selectedSkills).toEqual([
      { name: 'project-summary', namespace: 'default', is_public: false },
    ])

    rerender({ locked: true })
    act(() => result.current.setSelectedSkills([]))

    expect(result.current.selectedSkills).toEqual([
      { name: 'project-summary', namespace: 'default', is_public: false },
    ])
  })

  test('uploads, removes, and resets attachments', async () => {
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }
    const upload = vi.fn().mockResolvedValue(attachment)
    const remove = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useWorkbenchAttachments({
        uploadAttachment: upload,
        deleteAttachment: remove,
      })
    )

    const file = new File(['hello'], 'brief.pdf', { type: 'application/pdf' })
    await act(async () => {
      await result.current.handleFileSelect(file)
    })

    expect(result.current.attachments).toEqual([attachment])
    expect(result.current.isAttachmentReadyToSend).toBe(true)

    await act(async () => {
      await result.current.removeAttachment(42)
    })

    expect(remove).toHaveBeenCalledWith(42)
    expect(result.current.attachments).toEqual([])

    act(() => result.current.addExistingAttachment(attachment))
    act(() => result.current.resetAttachments())
    expect(result.current.attachments).toEqual([])
  })

  test('releases temporary image previews when attachments leave the composer', async () => {
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const firstAttachment: Attachment = {
      id: 44,
      filename: 'first.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
      local_preview_url: 'blob:first-preview',
    }
    const secondAttachment: Attachment = {
      ...firstAttachment,
      id: 45,
      filename: 'second.png',
      local_preview_url: 'blob:second-preview',
    }
    const remove = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useWorkbenchAttachments({ deleteAttachment: remove }))

    act(() => {
      result.current.addExistingAttachment(firstAttachment)
      result.current.addExistingAttachment(secondAttachment)
    })
    await act(async () => result.current.removeAttachment(firstAttachment.id))
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first-preview')

    act(() => result.current.resetAttachments())
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second-preview')
  })

  test('removes an Appshot image and its hidden text context together', async () => {
    const appshot: Attachment = {
      id: -10,
      filename: 'appshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-07-15T00:00:00.000Z',
      ui_group_id: 'appshot-capture-1',
      ui_group_role: 'primary',
      ui_kind: 'appshot',
    }
    const textContext: Attachment = {
      ...appshot,
      id: -11,
      filename: 'appshot-context.txt',
      mime_type: 'text/plain',
      file_extension: '.txt',
      ui_group_role: 'companion',
    }
    const remove = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useWorkbenchAttachments({ deleteAttachment: remove }))

    act(() => {
      result.current.addExistingAttachment(appshot)
      result.current.addExistingAttachment(textContext)
    })
    await act(async () => result.current.removeAttachment(appshot.id))

    expect(result.current.attachments).toEqual([])
    expect(remove).not.toHaveBeenCalled()
  })

  test('uploads attachments without restricting file extensions', async () => {
    const attachment: Attachment = {
      id: 43,
      filename: 'init_env.sh',
      file_size: 1200,
      mime_type: 'application/x-sh',
      status: 'ready',
      file_extension: '.sh',
      created_at: '2026-05-27T00:00:00.000Z',
    }
    const upload = vi.fn().mockResolvedValue(attachment)

    const { result } = renderHook(() =>
      useWorkbenchAttachments({
        uploadAttachment: upload,
        deleteAttachment: vi.fn(),
      })
    )

    const file = new File(['#!/bin/sh'], 'init_env.sh', {
      type: 'application/x-sh',
    })
    await act(async () => {
      await result.current.handleFileSelect(file)
    })

    expect(upload).toHaveBeenCalledWith(file, expect.any(Function))
    expect(result.current.attachments).toEqual([attachment])
    expect(result.current.errors.size).toBe(0)
  })

  test('adds text preview metadata for pasted text attachments', async () => {
    const attachment: Attachment = {
      id: 44,
      filename: 'clipboard-text-1783070360990.txt',
      file_size: 1200,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: '.txt',
      created_at: '2026-05-27T00:00:00.000Z',
    }
    const upload = vi.fn().mockResolvedValue(attachment)

    const { result } = renderHook(() =>
      useWorkbenchAttachments({
        uploadAttachment: upload,
        deleteAttachment: vi.fn(),
      })
    )

    const file = new File(
      ['{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}'],
      'clipboard-text-1783070360990.txt',
      { type: 'text/plain' }
    )
    await act(async () => {
      await result.current.handleFileSelect(file)
    })

    expect(result.current.attachments[0]).toEqual(
      expect.objectContaining({
        text_preview: '{ "event_type": "http_exchange", "id": "e9972aac" }',
        text_content: '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}',
        text_length: 55,
      })
    )
  })
})
