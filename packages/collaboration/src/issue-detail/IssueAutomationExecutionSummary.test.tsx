// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue } from '../types'

import { IssueAutomationExecutionSummary } from './IssueAutomationExecutionSummary'
import type { SharedWorkflowNode } from './workflowTypes'
import type { WorkflowCoordinatorConfiguration } from './workflowConfiguration'

const nodes: SharedWorkflowNode[] = [
  {
    id: 'claude',
    name: 'Claude 实现',
    depends_on: [],
    required: true,
    workspace_policy: 'none',
    required_assignee_type: 'agent',
    required_assignee_id: 'agent-claude',
    status: 'running',
  },
  {
    id: 'codex',
    name: 'Codex 验证',
    depends_on: ['claude'],
    required: true,
    workspace_policy: 'none',
    required_assignee_type: 'agent',
    required_assignee_id: 'agent-codex',
    status: 'blocked',
  },
]

describe('IssueAutomationExecutionSummary', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(
    targetNodes: SharedWorkflowNode[],
    issueCompleted = false,
    workflow?: WorkflowCoordinatorConfiguration,
    extra: Partial<ComponentProps<typeof IssueAutomationExecutionSummary>> = {},
  ) {
    act(() => {
      root.render(
        <IssueAutomationExecutionSummary
          nodes={targetNodes}
          workflow={workflow}
          agents={[
            { id: 'agent-claude', name: 'Claude' },
            { id: 'agent-codex', name: 'Codex' },
          ]}
          location="cloud"
          issueCompleted={issueCompleted}
          translate={(_key, fallback) => fallback ?? ''}
          {...extra}
        />,
      )
    })
  }

  it('shows the blocked child execution instead of the ready workflow snapshot', () => {
    const child = {
      id: 'child-1',
      title: '执行 pwd',
      status: 'pending',
      execution_state: 'waiting_runtime',
    } as CollaborationIssue
    const onOpenChild = vi.fn()
    render([{ ...nodes[0], status: 'ready' }], false, undefined, {
      plan: { stage_id: 'claude', items: [{ task_id: child.id }] },
      childIssues: [child],
      onOpenChild,
    })
    const stage = container.querySelector(
      '[data-testid="collaboration-automation-stage-0"]',
    )!
    expect(stage.textContent).toContain('子任务等待设备或模型配置')
    expect(stage.textContent).not.toContain('准备执行')
    act(() => (stage.querySelector('button') as HTMLButtonElement).click())
    expect(onOpenChild).toHaveBeenCalledWith(child)
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-progress"]',
      )?.textContent,
    ).toBe('0 / 1')
  })

  it('keeps successful child execution separate from workflow completion', () => {
    render([{ ...nodes[0], status: 'ready' }], false, undefined, {
      plan: { stage_id: 'claude', items: [{ task_id: 'child-1' }] },
      childIssues: [
        {
          id: 'child-1',
          execution_state: 'succeeded',
          status: 'pending',
        } as CollaborationIssue,
      ],
    })
    expect(container.textContent).toContain('子任务执行已结束，等待验收')
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-progress"]',
      )?.textContent,
    ).toBe('0 / 1')
  })

  it('shows each stage once with its own status and active agent', () => {
    render(nodes)

    const stageList = container.querySelector(
      '[data-testid="collaboration-automation-rule-chain"]',
    )!
    expect(stageList.querySelectorAll('article')).toHaveLength(2)
    expect(container.textContent?.match(/Claude 实现/g)).toHaveLength(1)
    expect(container.textContent?.match(/Codex 验证/g)).toHaveLength(1)
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-stage-0"]',
      )?.textContent,
    ).toContain('执行中 · Claude · 云端空间')
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-stage-1"]',
      )?.textContent,
    ).toContain('等待前序阶段')
    expect(container.textContent).not.toContain('云端空间 · 云端空间')
  })

  it('shows the agent selected by a direct stage execution config', () => {
    render([
      {
        ...nodes[0],
        required_assignee_type: null,
        required_assignee_id: null,
        execution_config: { agent_id: 'agent-claude' },
      },
    ])

    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-stage-0"]',
      )?.textContent,
    ).toContain('执行中 · Claude · 云端空间')
  })

  it('shows the next agent running only after Claude completes', () => {
    render([
      { ...nodes[0], status: 'completed' },
      { ...nodes[1], status: 'running' },
    ])

    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-progress"]',
      )?.textContent,
    ).toContain('1 / 2')
    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-stage-1"]',
      )?.textContent,
    ).toContain('执行中 · Codex · 云端空间')
  })

  it('shows the automatic Issue completion result', () => {
    render(
      nodes.map((node) => ({ ...node, status: 'completed' })),
      true,
    )

    expect(
      container.querySelector(
        '[data-testid="collaboration-automation-progress"]',
      )?.textContent,
    ).toContain('2 / 2')
    expect(container.textContent?.match(/已完成/g)).toHaveLength(2)
  })

  it('shows the missing configuration and settings path instead of preparing', () => {
    render([{ ...nodes[0], status: 'ready' }], false, {
      advancement_policy: 'ai',
      orchestration_status: 'idle',
      execution_config: { model: null, execution_device_id: null },
    })
    expect(container.textContent).toContain('等待配置')
    expect(container.textContent).toContain(
      '项目设置 → 自动处理 → 我的默认执行配置',
    )
    expect(container.textContent).not.toContain('准备执行')
  })

  it('keeps a managed coordinator without custom settings ready', () => {
    render([{ ...nodes[0], status: 'ready' }], false, {
      advancement_policy: 'ai',
      orchestration_status: 'idle',
      execution_config: null,
    })
    expect(container.textContent).toContain('准备执行')
    expect(container.textContent).not.toContain('等待配置')
  })
})
