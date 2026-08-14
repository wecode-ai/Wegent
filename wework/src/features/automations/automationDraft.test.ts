import { describe, expect, test } from 'vitest'
import type { RuntimeProjectWork } from '@/types/api'
import type { Automation } from '@/types/automation'
import {
  automationModelFields,
  automationDraftFromAutomation,
  automationWorkspaceTarget,
  buildAutomationProjectOptions,
  buildAutomationTaskOptions,
  emptyAutomationDraft,
  initialGoalFromAutomationDraft,
  scheduleFromAutomationDraft,
} from './automationDraft'

describe('automationModelFields', () => {
  test('preserves the complete cloud model identity for execution', () => {
    expect(
      automationModelFields(
        {
          name: 'desktop-e2e-public-model',
          type: 'public',
          displayName: 'Desktop E2E Public Model',
          provider: 'openai',
          modelId: 'desktop-e2e-public-upstream-model',
          namespace: 'default',
          resourceUserId: 0,
          config: {
            protocol: 'openai-responses',
            apiFormat: 'responses',
          },
          runtime: { family: 'openai.openai-responses' },
        },
        { reasoningEffort: 'medium' }
      )
    ).toEqual({
      modelId: 'desktop-e2e-public-model',
      modelType: 'public',
      modelOptions: {
        reasoningEffort: 'medium',
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
        weworkCloudModelUpstreamApiFormat: 'openai-responses',
      },
    })
  })
})

describe('automationWorkspaceTarget', () => {
  test('uses a selected project workspace', () => {
    expect(automationWorkspaceTarget(' /repo/wework ')).toEqual({
      workspacePath: '/repo/wework',
    })
  })

  test('creates an independent chat workspace when no project is selected', () => {
    expect(automationWorkspaceTarget('')).toEqual({
      standaloneChatWorkspace: true,
    })
  })
})

function project(name: string, roots: string[], workspacePaths: string[]): RuntimeProjectWork {
  return {
    project: {
      key: `local:${name}`,
      name,
      source: 'local_project',
      stateDeviceId: 'local-device',
      roots: roots.map(path => ({ kind: 'local', path })),
    },
    deviceWorkspaces: workspacePaths.map(workspacePath => ({
      deviceId: 'local-device',
      available: true,
      workspacePath,
      tasks: [],
    })),
  }
}

describe('buildAutomationProjectOptions', () => {
  test('shows one option per multi-root project and selects its primary root', () => {
    const options = buildAutomationProjectOptions(
      [project('wework', ['/repo/wework', '/repo/docs'], ['/repo/docs', '/repo/wework'])],
      'local-device'
    )

    expect(options).toEqual([
      {
        key: 'local-device\u0000local:wework\u0000/repo/wework',
        name: 'wework',
        workspacePath: '/repo/wework',
        workspaceKind: undefined,
        workspaceLabel: null,
      },
    ])
  })

  test('filters projects to the selected device', () => {
    const runtimeProject = project('wework', ['/repo/wework'], ['/repo/wework'])
    runtimeProject.deviceWorkspaces.push({
      deviceId: 'cloud-device',
      available: true,
      workspacePath: '/cloud/wework',
      tasks: [],
    })

    expect(buildAutomationProjectOptions([runtimeProject], 'cloud-device')).toEqual([
      {
        key: 'local-device\u0000local:wework\u0000/cloud/wework',
        name: 'wework',
        workspacePath: '/cloud/wework',
        workspaceKind: undefined,
        workspaceLabel: null,
      },
    ])
  })

  test('keeps managed worktrees selectable alongside the primary project workspace', () => {
    const runtimeProject = project('wework', ['/repo/wework'], ['/repo/wework'])
    runtimeProject.deviceWorkspaces.push({
      deviceId: 'local-device',
      available: true,
      workspacePath: '/worktrees/task-42/wework',
      workspaceKind: 'worktree',
      worktreeId: 'task-42',
      label: 'feature/automation',
      tasks: [],
    })

    expect(buildAutomationProjectOptions([runtimeProject], 'local-device')).toEqual([
      {
        key: 'local-device\u0000local:wework\u0000/repo/wework',
        name: 'wework',
        workspacePath: '/repo/wework',
        workspaceKind: undefined,
        workspaceLabel: null,
      },
      {
        key: 'local-device\u0000local:wework\u0000/worktrees/task-42/wework',
        name: 'wework',
        workspacePath: '/worktrees/task-42/wework',
        workspaceKind: 'worktree',
        workspaceLabel: 'feature/automation',
      },
    ])
  })
})

describe('buildAutomationTaskOptions', () => {
  test('only exposes pinned continuable tasks from local devices', () => {
    const runtimeProject = project('wework', ['/repo/wework'], ['/repo/wework'])
    runtimeProject.deviceWorkspaces[0].tasks = [
      {
        taskId: 'pinned-task',
        workspacePath: '/repo/wework',
        title: 'Pinned task',
        runtime: 'codex',
        pinned: true,
        continuable: true,
      },
      {
        taskId: 'regular-task',
        workspacePath: '/repo/wework',
        title: 'Regular task',
        runtime: 'codex',
        pinned: false,
        continuable: true,
      },
    ]
    runtimeProject.deviceWorkspaces.push({
      deviceId: 'cloud-device',
      available: true,
      workspacePath: '/cloud/wework',
      tasks: [
        {
          taskId: 'cloud-pinned-task',
          workspacePath: '/cloud/wework',
          title: 'Cloud pinned task',
          runtime: 'codex',
          pinned: true,
          continuable: true,
        },
      ],
    })

    expect(
      buildAutomationTaskOptions(
        { projects: [runtimeProject], chats: [], totalTasks: 3 },
        new Set(['local-device'])
      )
    ).toEqual([
      {
        key: 'local-device:pinned-task',
        label: 'Pinned task · wework',
        address: {
          deviceId: 'local-device',
          taskId: 'pinned-task',
          threadId: undefined,
          workspacePath: '/repo/wework',
          runtimeHandle: undefined,
        },
      },
    ])
  })
})

describe('automation schedule draft conversion', () => {
  test('saves ChatGPT-style custom weekly recurrence as a multi-day cron schedule', () => {
    const draft = emptyAutomationDraft('local')
    draft.cronPreset = 'custom'
    draft.customFrequency = 'weekly'
    draft.customInterval = '1'
    draft.customWeekdays = ['1', '2', '4']
    draft.cronTime = '08:15'

    expect(scheduleFromAutomationDraft(draft)).toEqual({
      type: 'cron',
      expression: '15 8 * * 1,2,4',
    })
  })

  test('round trips an hourly interval through the custom frequency editor', () => {
    const automation: Automation = {
      id: 'local:hourly',
      version: 1,
      source: 'local',
      name: 'Hourly check',
      description: '',
      prompt: 'Check status',
      schedule: { type: 'interval', value: 3, unit: 'hours' },
      timezone: 'Asia/Shanghai',
      enabled: true,
      conversationMode: 'independent',
      notificationPolicy: 'all_runs',
      taskPayload: {},
      createdAt: '2026-07-29T00:00:00Z',
      updatedAt: '2026-07-29T00:00:00Z',
    }

    const draft = automationDraftFromAutomation(automation)

    expect(draft.scheduleType).toBe('cron')
    expect(draft.cronPreset).toBe('custom')
    expect(draft.customFrequency).toBe('hourly')
    expect(draft.customInterval).toBe('3')
    expect(scheduleFromAutomationDraft(draft)).toEqual({
      type: 'interval',
      value: 3,
      unit: 'hours',
    })
  })
})

describe('automation goal draft conversion', () => {
  test('builds an active runtime goal when goal mode is enabled', () => {
    const draft = emptyAutomationDraft('local')
    draft.goalEnabled = true
    draft.prompt = '  Keep CI green  '

    expect(initialGoalFromAutomationDraft(draft)).toEqual({
      objective: 'Keep CI green',
      status: 'active',
      tokenBudget: null,
    })
  })

  test('round trips a persisted automation goal', () => {
    const automation: Automation = {
      id: 'local:goal',
      version: 1,
      source: 'local',
      name: 'CI caretaker',
      description: '',
      prompt: 'Inspect CI and fix failures',
      schedule: { type: 'cron', expression: '0 9 * * 1-5' },
      timezone: 'Asia/Shanghai',
      enabled: true,
      conversationMode: 'independent',
      notificationPolicy: 'all_runs',
      taskPayload: {
        initialGoal: {
          objective: 'Keep CI green',
          status: 'active',
          tokenBudget: null,
        },
      },
      createdAt: '2026-08-12T00:00:00Z',
      updatedAt: '2026-08-12T00:00:00Z',
    }

    const draft = automationDraftFromAutomation(automation)

    expect(draft.goalEnabled).toBe(true)
    expect(initialGoalFromAutomationDraft(draft)).toEqual({
      objective: 'Inspect CI and fix failures',
      status: 'active',
      tokenBudget: null,
    })
  })
})
