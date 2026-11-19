// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { CollaborationExecutionEnvironmentConfig } from '../types'
import { useEnvironmentConfigurationDraft } from './useEnvironmentConfigurationDraft'

it('keeps a dirty draft at its original base version until an explicit rebase accepts the new snapshot', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const scope = {}
  const original: CollaborationExecutionEnvironmentConfig = {
    workspace_policy: 'git_worktree',
    repositories: [],
    setup_steps: [],
  }
  const latest: CollaborationExecutionEnvironmentConfig = {
    ...original,
    setup_steps: [{ command: 'server-setup', working_directory: '' }],
  }
  let draft!: ReturnType<typeof useEnvironmentConfigurationDraft>
  function Probe({
    version,
    configuration,
  }: {
    version: number
    configuration: CollaborationExecutionEnvironmentConfig
  }) {
    draft = useEnvironmentConfigurationDraft({
      scope,
      version,
      configuration,
      ready: true,
      blocked: false,
    })
    return null
  }
  try {
    await act(async () => root.render(<Probe version={1} configuration={original} />))
    await act(async () => {
      draft.setWorkspacePolicy('project')
      draft.setConfigurationDirty(true)
    })
    await act(async () => root.render(<Probe version={3} configuration={latest} />))

    expect(draft.configVersion).toBe(1)
    expect(draft.workspacePolicy).toBe('project')
    expect(draft.setupSteps).toEqual([])
    expect(draft.configurationDirty).toBe(true)

    await act(async () => draft.rebaseConfiguration(3, latest))

    expect(draft.configVersion).toBe(3)
    expect(draft.workspacePolicy).toBe('project')
    expect(draft.setupSteps).toEqual([])
    expect(draft.configurationDirty).toBe(true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
