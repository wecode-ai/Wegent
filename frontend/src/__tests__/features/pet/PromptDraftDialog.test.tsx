// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { modelApis } from '@/apis/models'
import { taskApis } from '@/apis/tasks'
import { PromptDraftDialog } from '@/features/pet/components/PromptDraftDialog'
import { getPromptDraftVersions } from '@/features/prompt-draft/utils/promptDraftStorage'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockToast = jest.fn()

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    generatePromptDraft: jest.fn(),
    generatePromptDraftStream: jest.fn(),
  },
}))

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn(),
  },
}))

describe('PromptDraftDialog', () => {
  const mockClipboard = {
    writeText: jest.fn(),
  }

  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    Object.assign(navigator, { clipboard: mockClipboard })
  })

  test('generates prompt draft and renders returned title and prompt', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({
      data: [
        {
          name: 'gpt-5.4',
          type: 'public',
          displayName: 'GPT-5.4',
          provider: 'openai',
        },
      ],
    })
    ;(taskApis.generatePromptDraftStream as jest.Mock).mockResolvedValue({
      title: '会话提炼提示词',
      prompt: '你是产品协作助手，负责帮助我沉淀协作方式。',
      model: 'gpt-5.4',
      version: 1,
      created_at: '2026-03-28T00:00:00Z',
    })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    await waitFor(() => {
      expect(modelApis.getUnifiedModels).toHaveBeenCalledWith(
        undefined,
        false,
        'all',
        undefined,
        'llm'
      )
    })

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))

    await waitFor(() => {
      expect(taskApis.generatePromptDraftStream).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ source: 'pet_panel' }),
        expect.any(Object)
      )
    })

    expect((await screen.findAllByText('会话提炼提示词')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/你是产品协作助手/)).length).toBeGreaterThan(0)
  })

  test('disables generate when task id is absent', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={null} />)
    await waitFor(() => {
      expect(modelApis.getUnifiedModels).toHaveBeenCalledWith(
        undefined,
        false,
        'all',
        undefined,
        'llm'
      )
    })
    expect(screen.getByTestId('prompt-draft-generate-button')).toBeDisabled()
  })

  test('isolates draft content by conversation', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock).mockResolvedValue({
      title: '会话A标题',
      prompt: '会话A提示词',
      model: 'gpt-5.4',
      version: 1,
      created_at: '2026-03-28T00:00:00Z',
    })

    const { rerender } = render(
      <PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />
    )

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('会话A标题')).length).toBeGreaterThan(0)

    rerender(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={2} />)

    await waitFor(() => {
      expect(screen.queryByText('会话A标题')).not.toBeInTheDocument()
    })
  })

  test('regenerate sends current prompt and regenerate flag', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock).mockResolvedValue({
      title: '会话提炼提示词',
      prompt: '你是产品协作助手，负责帮助我沉淀协作方式。',
      model: 'gpt-5.4',
      version: 1,
      created_at: '2026-03-28T00:00:00Z',
    })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('会话提炼提示词')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))

    await waitFor(() => {
      expect(taskApis.generatePromptDraftStream).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({
          source: 'pet_panel',
          regenerate: true,
          current_prompt: '你是产品协作助手，负责帮助我沉淀协作方式。',
        }),
        expect.any(Object)
      )
    })
  })

  test('regenerate enters comparison mode and keeps the current version untouched', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock)
      .mockResolvedValueOnce({
        title: '版本一',
        prompt: '你是A助手，负责A。',
        model: 'gpt-5.4',
        version: 1,
        created_at: '2026-03-28T00:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本二',
        prompt: '你是B助手，负责B。',
        model: 'gpt-5.4',
        version: 2,
        created_at: '2026-03-28T01:00:00Z',
      })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    expect((await screen.findAllByText('版本二')).length).toBeGreaterThan(0)
    expect(screen.getByTestId('prompt-draft-comparison-panel')).toBeInTheDocument()
    expect(screen.getByTestId('prompt-draft-keep-old-button')).toBeInTheDocument()
    expect(screen.getByTestId('prompt-draft-use-new-button')).toBeInTheDocument()

    const versions = getPromptDraftVersions('task-1')
    expect(versions?.versions).toHaveLength(1)
    expect(versions?.versions[0].title).toBe('版本一')
    expect(
      screen.getByTestId(`prompt-draft-rollback-button-${versions?.versions[0].id}`)
    ).toBeDisabled()
  })

  test('keep old discards regenerated candidate', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock)
      .mockResolvedValueOnce({
        title: '版本一',
        prompt: '你是A助手，负责A。',
        model: 'gpt-5.4',
        version: 1,
        created_at: '2026-03-28T00:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本二',
        prompt: '你是B助手，负责B。',
        model: 'gpt-5.4',
        version: 2,
        created_at: '2026-03-28T01:00:00Z',
      })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    expect((await screen.findAllByText('版本二')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-keep-old-button'))

    expect(screen.queryByTestId('prompt-draft-comparison-panel')).not.toBeInTheDocument()
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    const versions = getPromptDraftVersions('task-1')
    expect(versions?.versions).toHaveLength(1)
    expect(versions?.versions[0].title).toBe('版本一')
  })

  test('use new saves the regenerated candidate as the current version', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock)
      .mockResolvedValueOnce({
        title: '版本一',
        prompt: '你是A助手，负责A。',
        model: 'gpt-5.4',
        version: 1,
        created_at: '2026-03-28T00:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本二',
        prompt: '你是B助手，负责B。',
        model: 'gpt-5.4',
        version: 2,
        created_at: '2026-03-28T01:00:00Z',
      })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    expect((await screen.findAllByText('版本二')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-use-new-button'))

    await waitFor(() => {
      expect(screen.queryByTestId('prompt-draft-comparison-panel')).not.toBeInTheDocument()
    })

    const versions = getPromptDraftVersions('task-1')
    expect(versions?.versions).toHaveLength(2)
    expect(versions?.versions[0].title).toBe('版本二')
    expect(versions?.currentVersionId).toBe(versions?.versions[0].id)
  })

  test('replaces fine-tune with copy prompt and writes the current prompt to clipboard', async () => {
    jest.useFakeTimers()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock).mockResolvedValue({
      title: '版本一',
      prompt: '你是产品协作助手，负责帮助我沉淀协作方式。',
      model: 'gpt-5.4',
      version: 1,
      created_at: '2026-03-28T00:00:00Z',
    })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    expect(screen.getByTestId('prompt-draft-copy-button')).toBeInTheDocument()
    expect(screen.queryByTestId('prompt-draft-fine-tune-button')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('prompt-draft-copy-button'))

    await waitFor(() => {
      expect(mockClipboard.writeText).toHaveBeenCalledWith(
        '你是产品协作助手，负责帮助我沉淀协作方式。'
      )
    })

    expect(mockToast).toHaveBeenCalledWith({
      title: 'promptDraft.copySuccess',
    })
    await waitFor(() => {
      expect(screen.getByTestId('prompt-draft-copy-button')).toHaveTextContent('promptDraft.copied')
    })

    act(() => {
      jest.advanceTimersByTime(2000)
    })

    expect(screen.getByTestId('prompt-draft-copy-button')).toHaveTextContent(
      'promptDraft.copyPrompt'
    )
    jest.useRealTimers()
  })

  test('rollback clones a historical version into a new current version', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock)
      .mockResolvedValueOnce({
        title: '版本一',
        prompt: '你是A助手，负责A。',
        model: 'gpt-5.4',
        version: 1,
        created_at: '2026-03-28T00:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本二',
        prompt: '你是B助手，负责B。',
        model: 'gpt-5.4',
        version: 2,
        created_at: '2026-03-28T01:00:00Z',
      })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    expect((await screen.findAllByText('版本二')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('prompt-draft-use-new-button'))
    expect((await screen.findAllByText('版本二')).length).toBeGreaterThan(0)

    const currentVersions = getPromptDraftVersions('task-1')
    const rollbackTargetId = currentVersions?.versions.find(
      version => version.title === '版本一'
    )?.id
    expect(rollbackTargetId).toBeDefined()

    fireEvent.click(screen.getByTestId(`prompt-draft-rollback-button-${rollbackTargetId}`))

    await waitFor(() => {
      expect(screen.queryByTestId('prompt-draft-comparison-panel')).not.toBeInTheDocument()
    })

    const versions = getPromptDraftVersions('task-1')
    expect(versions?.versions).toHaveLength(3)
    expect(versions?.versions[0].title).toBe('版本一')
    expect(versions?.versions[0].source).toBe('rollback')
  })

  test('history compare uses a fresh rollback timestamp when accepting the selected version', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock)
      .mockResolvedValueOnce({
        title: '版本一',
        prompt: '你是A助手，负责A。',
        model: 'gpt-5.4',
        version: 1,
        created_at: '2026-03-28T00:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本二',
        prompt: '你是B助手，负责B。',
        model: 'gpt-5.4',
        version: 2,
        created_at: '2026-03-28T01:00:00Z',
      })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    expect((await screen.findAllByText('版本二')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('prompt-draft-use-new-button'))
    expect((await screen.findAllByText('版本二')).length).toBeGreaterThan(0)

    const compareVersions = getPromptDraftVersions('task-1')
    const historyTarget = compareVersions?.versions.find(version => version.title === '版本一')
    expect(historyTarget).toBeDefined()

    fireEvent.click(screen.getByTestId(`prompt-draft-compare-button-${historyTarget?.id}`))
    fireEvent.click(await screen.findByTestId('prompt-draft-use-new-button'))

    await waitFor(() => {
      expect(screen.queryByTestId('prompt-draft-comparison-panel')).not.toBeInTheDocument()
    })

    const versions = getPromptDraftVersions('task-1')
    expect(versions?.versions[0].title).toBe('版本一')
    expect(versions?.versions[0].source).toBe('rollback')
    expect(versions?.versions[0].createdAt).not.toBe('2026-03-28T00:00:00Z')
  })

  test('keeps only three versions after repeated regenerations', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock)
      .mockResolvedValueOnce({
        title: '版本一',
        prompt: '你是A助手，负责A。',
        model: 'gpt-5.4',
        version: 1,
        created_at: '2026-03-28T00:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本二',
        prompt: '你是B助手，负责B。',
        model: 'gpt-5.4',
        version: 2,
        created_at: '2026-03-28T01:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本三',
        prompt: '你是C助手，负责C。',
        model: 'gpt-5.4',
        version: 3,
        created_at: '2026-03-28T02:00:00Z',
      })
      .mockResolvedValueOnce({
        title: '版本四',
        prompt: '你是D助手，负责D。',
        model: 'gpt-5.4',
        version: 4,
        created_at: '2026-03-28T03:00:00Z',
      })

    render(<PromptDraftDialog open={true} onOpenChange={() => {}} taskId={1} />)

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))
    expect((await screen.findAllByText('版本一')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    fireEvent.click(await screen.findByTestId('prompt-draft-use-new-button'))
    await screen.findAllByText('版本二')

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    fireEvent.click(await screen.findByTestId('prompt-draft-use-new-button'))
    await screen.findAllByText('版本三')

    fireEvent.click(screen.getByTestId('prompt-draft-regenerate-button'))
    fireEvent.click(await screen.findByTestId('prompt-draft-use-new-button'))
    await screen.findAllByText('版本四')

    const versions = getPromptDraftVersions('task-1')
    expect(versions?.versions).toHaveLength(3)
    expect(versions?.versions[0].title).toBe('版本四')
  })

  test('closing the dialog while generation is in flight does not persist the hidden result', async () => {
    let resolveGenerate: ((value: unknown) => void) | null = null

    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: [] })
    ;(taskApis.generatePromptDraftStream as jest.Mock).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveGenerate = resolve as (value: unknown) => void
        })
    )

    const onOpenChange = jest.fn()
    const { rerender } = render(
      <PromptDraftDialog open={true} onOpenChange={onOpenChange} taskId={1} />
    )

    fireEvent.click(screen.getByTestId('prompt-draft-generate-button'))

    rerender(<PromptDraftDialog open={false} onOpenChange={onOpenChange} taskId={1} />)

    resolveGenerate!({
      title: '隐藏版本',
      prompt: '这份结果不该在关闭后写入本地存储。',
      model: 'gpt-5.4',
      version: 1,
      created_at: '2026-03-28T00:00:00Z',
    })

    await waitFor(() => {
      expect(taskApis.generatePromptDraftStream).toHaveBeenCalledTimes(1)
    })

    expect(getPromptDraftVersions('task-1')).toBeNull()
  })
})
