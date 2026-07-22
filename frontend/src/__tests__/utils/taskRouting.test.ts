// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getTaskTargetHref, getTaskTargetPath, resolveChatPageTaskType } from '@/utils/taskRouting'

describe('taskRouting', () => {
  it('keeps an existing code task in cloud mode when a device selection is stale', () => {
    expect(
      resolveChatPageTaskType({
        taskId: '5',
        selectedTask: { id: 5, task_type: 'code' },
        selectedDeviceId: 'stale-device',
        isCodeAgentMode: false,
      })
    ).toBe('code')
  })

  it('does not use a stale device while an existing task is loading', () => {
    expect(
      resolveChatPageTaskType({
        taskId: '5',
        selectedTask: { id: 4, task_type: 'task' },
        selectedDeviceId: 'stale-device',
        isCodeAgentMode: true,
      })
    ).toBe('code')
  })

  it('uses the selected device for a new task', () => {
    expect(
      resolveChatPageTaskType({
        selectedDeviceId: 'device-1',
        isCodeAgentMode: false,
      })
    ).toBe('task')
  })

  it('routes knowledge tasks with knowledge base context to the notebook entry', () => {
    expect(
      getTaskTargetHref({
        id: 12,
        task_type: 'knowledge',
        knowledge_base_id: 34,
      })
    ).toBe('/knowledge/document/34?taskId=12')
  })

  it('keeps knowledge tasks without knowledge base context in the knowledge area', () => {
    expect(
      getTaskTargetHref({
        id: 12,
        task_type: 'knowledge',
      })
    ).toBe('/knowledge?taskId=12')
  })

  it('routes non-knowledge tasks to their owning work surfaces', () => {
    expect(getTaskTargetPath({ id: 1, task_type: 'task' })).toBe('/devices/chat')
    expect(getTaskTargetPath({ id: 2, task_type: 'video' })).toBe('/generate')
    expect(getTaskTargetPath({ id: 3, task_type: 'image' })).toBe('/generate')
    expect(getTaskTargetPath({ id: 4, task_type: 'chat' })).toBe('/chat')
    expect(getTaskTargetPath({ id: 5, task_type: 'code' })).toBe('/chat')
  })
})
