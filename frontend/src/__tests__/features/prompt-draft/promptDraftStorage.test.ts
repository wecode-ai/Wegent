// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  clearPromptDraft,
  getPromptDraft,
  getPromptDraftVersions,
  savePromptDraft,
  savePromptDraftVersions,
  setCurrentPromptDraftVersion,
} from '@/features/prompt-draft/utils/promptDraftStorage'

describe('promptDraftStorage feature module', () => {
  const taskId = 42

  beforeEach(() => {
    localStorage.clear()
  })

  const createVersion = (id: string, title: string, version: number) => ({
    id,
    title,
    prompt: `prompt-${id}`,
    model: `model-${id}`,
    version,
    createdAt: `2026-03-28T0${version}:00:00Z`,
    sourceConversationId: String(taskId),
    source: 'initial' as const,
  })

  test('save and load the current draft version', () => {
    savePromptDraft(taskId, {
      title: 'v1',
      prompt: 'prompt-v1',
      model: 'm1',
      version: 1,
      createdAt: '2026-03-28T00:00:00Z',
      sourceConversationId: String(taskId),
    })
    savePromptDraft(taskId, {
      title: 'v2',
      prompt: 'prompt-v2',
      model: 'm2',
      version: 2,
      createdAt: '2026-03-28T01:00:00Z',
      sourceConversationId: String(taskId),
    })

    const draft = getPromptDraft(taskId)
    const versions = getPromptDraftVersions(taskId)

    expect(draft).not.toBeNull()
    expect(draft?.title).toBe('v2')
    expect(versions?.versions).toHaveLength(2)
    expect(versions?.currentVersionId).toBe(versions?.versions[0].id)
    expect(versions?.versions[0].version).toBe(2)
  })

  test('appends duplicate version numbers without overwriting history', () => {
    savePromptDraft(taskId, {
      title: 'v1',
      prompt: 'prompt-v1',
      model: 'm1',
      version: 1,
      createdAt: '2026-03-28T00:00:00Z',
      sourceConversationId: String(taskId),
    })
    savePromptDraft(taskId, {
      title: 'v1b',
      prompt: 'prompt-v1b',
      model: 'm1b',
      version: 1,
      createdAt: '2026-03-28T00:30:00Z',
      sourceConversationId: String(taskId),
    })

    const versions = getPromptDraftVersions(taskId)

    expect(versions?.versions).toHaveLength(2)
    expect(versions?.versions[0].version).toBe(1)
    expect(versions?.versions[1].version).toBe(1)
    expect(versions?.versions[0].id).not.toBe(versions?.versions[1].id)
    expect(getPromptDraft(taskId)?.title).toBe('v1b')
  })

  test('migrates legacy flat payload into versioned storage', () => {
    localStorage.setItem(
      'pet:prompt-draft:42',
      JSON.stringify({
        title: 'legacy',
        prompt: 'prompt-legacy',
        model: 'legacy-model',
        version: 7,
        createdAt: '2026-03-28T07:00:00Z',
        sourceConversationId: String(taskId),
      })
    )

    const draft = getPromptDraft(taskId)
    const versions = getPromptDraftVersions(taskId)

    expect(draft?.title).toBe('legacy')
    expect(versions?.currentVersionId).toBe(versions?.versions[0].id)
    expect(versions?.versions).toHaveLength(1)
    expect(versions?.versions[0].source).toBe('initial')
  })

  test('clears invalid shaped payload after json parse', () => {
    localStorage.setItem(
      'pet:prompt-draft:42',
      JSON.stringify({
        title: 'broken',
        prompt: 'prompt-broken',
      })
    )

    const draft = getPromptDraft(taskId)

    expect(draft).toBeNull()
    expect(localStorage.getItem('pet:prompt-draft:42')).toBeNull()
  })

  test('trims version history to three entries and keeps the latest as current', () => {
    savePromptDraft(taskId, {
      title: 'v1',
      prompt: 'prompt-v1',
      model: 'm1',
      version: 1,
      createdAt: '2026-03-28T00:00:00Z',
      sourceConversationId: String(taskId),
    })
    savePromptDraft(taskId, {
      title: 'v2',
      prompt: 'prompt-v2',
      model: 'm2',
      version: 2,
      createdAt: '2026-03-28T01:00:00Z',
      sourceConversationId: String(taskId),
    })
    savePromptDraft(taskId, {
      title: 'v3',
      prompt: 'prompt-v3',
      model: 'm3',
      version: 3,
      createdAt: '2026-03-28T02:00:00Z',
      sourceConversationId: String(taskId),
    })
    savePromptDraft(taskId, {
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

  test('promotes an existing version to current without losing history', () => {
    savePromptDraftVersions(taskId, {
      currentVersionId: 'v3',
      versions: [
        createVersion('v3', 'v3', 3),
        createVersion('v2', 'v2', 2),
        createVersion('v1', 'v1', 1),
      ],
    })

    const updated = setCurrentPromptDraftVersion(taskId, 'v2')

    expect(updated?.currentVersionId).toBe('v2')
    expect(updated?.versions).toHaveLength(3)
    expect(getPromptDraft(taskId)?.title).toBe('v2')
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
