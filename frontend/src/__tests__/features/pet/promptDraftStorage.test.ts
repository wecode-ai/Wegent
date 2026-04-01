// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  appendPromptDraftVersion,
  clearPromptDraft,
  getPromptDraft,
  getPromptDraftVersions,
  savePromptDraft,
} from '@/features/pet/utils/promptDraftStorage'

describe('promptDraftStorage', () => {
  const taskId = 42

  beforeEach(() => {
    localStorage.clear()
  })

  test('save and load current version through pet re-export', () => {
    savePromptDraft(taskId, {
      title: '会话提炼提示词',
      prompt: '你是产品协作助手，负责帮助我沉淀协作方式。',
      model: 'gpt-5.4',
      version: 1,
      createdAt: '2026-03-28T00:00:00Z',
      sourceConversationId: String(taskId),
    })

    const draft = getPromptDraft(taskId)
    expect(draft).not.toBeNull()
    expect(draft?.title).toBe('会话提炼提示词')
    expect(draft?.prompt.startsWith('你是')).toBe(true)
  })

  test('append versions and keep only three entries', () => {
    appendPromptDraftVersion(taskId, {
      title: 'v1',
      prompt: 'prompt-v1',
      model: 'm1',
      version: 1,
      createdAt: '2026-03-28T00:00:00Z',
      sourceConversationId: String(taskId),
    })
    appendPromptDraftVersion(taskId, {
      title: 'v2',
      prompt: 'prompt-v2',
      model: 'm2',
      version: 2,
      createdAt: '2026-03-28T01:00:00Z',
      sourceConversationId: String(taskId),
    })
    appendPromptDraftVersion(taskId, {
      title: 'v3',
      prompt: 'prompt-v3',
      model: 'm3',
      version: 3,
      createdAt: '2026-03-28T02:00:00Z',
      sourceConversationId: String(taskId),
    })
    appendPromptDraftVersion(taskId, {
      title: 'v4',
      prompt: 'prompt-v4',
      model: 'm4',
      version: 4,
      createdAt: '2026-03-28T03:00:00Z',
      sourceConversationId: String(taskId),
    })

    const versions = getPromptDraftVersions(taskId)

    expect(versions?.versions).toHaveLength(3)
    expect(versions?.currentVersionId).toBe(versions?.versions[0].id)
    expect(versions?.versions.map(item => item.title)).toEqual(['v4', 'v3', 'v2'])
  })

  test('returns null and clears corrupted payload', () => {
    localStorage.setItem('pet:prompt-draft:42', '{bad json')

    const draft = getPromptDraft(taskId)
    expect(draft).toBeNull()
    expect(localStorage.getItem('pet:prompt-draft:42')).toBeNull()
  })

  test('clear draft by task id', () => {
    savePromptDraft(taskId, {
      title: 'to-clear',
      prompt: '你是清理助手，负责清理。',
      model: 'gpt-5.4',
      version: 1,
      createdAt: '2026-03-28T00:00:00Z',
      sourceConversationId: String(taskId),
    })

    clearPromptDraft(taskId)
    expect(getPromptDraft(taskId)).toBeNull()
    expect(getPromptDraftVersions(taskId)).toBeNull()
  })
})
