// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type SetStateAction } from 'react'

import type {
  CollaborationExecutionEnvironmentConfig,
  CollaborationExecutionEnvironmentRepository,
  CollaborationExecutionEnvironmentSetupStep,
} from '../types'

export type RepositoryDraft = CollaborationExecutionEnvironmentRepository & { id: string }
export type SetupStepDraft = CollaborationExecutionEnvironmentSetupStep & { id: string }

let nextDraftId = 0
export function environmentDraftId(prefix: string) {
  nextDraftId += 1
  return `${prefix}-${nextDraftId}`
}

interface Source {
  scope: object
  version: number
  configuration: CollaborationExecutionEnvironmentConfig | null | undefined
}

interface Draft {
  source: Source
  initialized: boolean
  version: number
  workspacePolicy: 'git_worktree' | 'project'
  repositories: RepositoryDraft[]
  setupSteps: SetupStepDraft[]
  dirty: boolean
}

function fromSource(source: Source, initialized: boolean): Draft {
  const configuration = initialized ? source.configuration : undefined
  return {
    source,
    initialized,
    version: initialized ? source.version : 0,
    workspacePolicy: configuration?.workspace_policy ?? 'git_worktree',
    repositories: (configuration?.repositories ?? []).map(repository => ({
      ...repository,
      id: environmentDraftId('repository'),
    })),
    setupSteps: (configuration?.setup_steps ?? []).map(step => ({
      ...step,
      id: environmentDraftId('setup'),
    })),
    dirty: false,
  }
}

function sameSource(left: Source, right: Source) {
  return (
    left.scope === right.scope &&
    left.version === right.version &&
    left.configuration === right.configuration
  )
}

/** Draft content and its optimistic-lock version always come from one snapshot. */
export function useEnvironmentConfigurationDraft({
  scope,
  configuration,
  version,
  ready,
  blocked,
}: Source & { ready: boolean; blocked: boolean }) {
  const source = { scope, configuration, version }
  const [draft, setDraft] = useState(() => fromSource(source, ready))
  const sameScope = draft.source.scope === scope
  const initialized =
    ready &&
    sameScope &&
    draft.initialized &&
    (draft.dirty || draft.version > version || sameSource(draft.source, source))

  useEffect(() => {
    if (!ready || blocked) return
    setDraft(current => {
      if (current.source.scope === scope && current.initialized) {
        if (sameSource(current.source, source)) return current
        // Observe the server snapshot without rebasing unsaved input onto it.
        if (current.dirty || version < current.version) return { ...current, source }
      }
      return fromSource(source, true)
    })
  }, [scope, configuration, version, ready, blocked])

  const setField = useCallback(
    <Key extends keyof Draft>(field: Key, update: SetStateAction<Draft[Key]>) => {
      setDraft(current => {
        if (current.source.scope !== scope) return current
        const value =
          typeof update === 'function'
            ? (update as (previous: Draft[Key]) => Draft[Key])(current[field])
            : update
        return { ...current, [field]: value }
      })
    },
    [scope]
  )
  const commitConfiguration = useCallback(
    (nextVersion: number, nextConfiguration: Source['configuration']) => {
      setDraft(current =>
        current.source.scope === scope
          ? fromSource({ scope, version: nextVersion, configuration: nextConfiguration }, true)
          : current
      )
    },
    [scope]
  )
  const rebaseConfiguration = useCallback(
    (nextVersion: number, nextConfiguration: Source['configuration']) => {
      setDraft(current =>
        current.source.scope === scope
          ? {
              ...current,
              source: { scope, version: nextVersion, configuration: nextConfiguration },
              version: nextVersion,
            }
          : current
      )
    },
    [scope]
  )

  return {
    ready: initialized,
    configVersion: draft.version,
    workspacePolicy: draft.workspacePolicy,
    repositories: sameScope ? draft.repositories : [],
    setupSteps: sameScope ? draft.setupSteps : [],
    configurationDirty: sameScope && draft.dirty,
    commitConfiguration,
    rebaseConfiguration,
    setWorkspacePolicy: (value: SetStateAction<Draft['workspacePolicy']>) =>
      setField('workspacePolicy', value),
    setRepositories: useCallback(
      (value: SetStateAction<RepositoryDraft[]>) => setField('repositories', value),
      [setField]
    ),
    setSetupSteps: (value: SetStateAction<SetupStepDraft[]>) => setField('setupSteps', value),
    setConfigurationDirty: (value: SetStateAction<boolean>) => setField('dirty', value),
  }
}
