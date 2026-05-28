import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useWorkbenchModels } from './useWorkbenchModels'
import { useWorkbenchSkills } from './useWorkbenchSkills'
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

    rerender({ locked: true })
    act(() => result.current.setSelectedModel(null))

    expect(result.current.selectedModel).toEqual(model)
  })

  test('keeps only models whose name includes claude', async () => {
    const claudeModel: UnifiedModel = { name: 'wecode-claude-sonnet-4-5', type: 'public' }
    const gptModel: UnifiedModel = { name: 'wecode-gpt-4.1', type: 'public' }
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [claudeModel, gptModel] }),
    }

    const { result } = renderHook(() => useWorkbenchModels({ api, locked: false }))

    await waitFor(() => expect(result.current.models).toEqual([claudeModel]))
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
})
