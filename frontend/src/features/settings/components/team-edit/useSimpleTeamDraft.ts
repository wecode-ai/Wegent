// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef, useState, type SetStateAction } from 'react'

import type { SkillRefMeta } from '@/apis/bots'
import type { ModelTypeEnum } from '@/apis/models'
import type { UnifiedShell } from '@/apis/shells'
import type { Bot, KnowledgeBaseDefaultRef, TaskType } from '@/types/api'

import {
  getModelFromConfig,
  getModelNamespaceFromConfig,
  getModelTypeFromConfig,
} from '../../services/bots'
import { stringifyMcpConfig } from '../../utils/mcpConfig'
import {
  normalizeExecutorForBindMode,
  resolveSimpleExecutorFromBot,
  type CodingExecutorRuntime,
  type SimpleExecutorMode,
} from './simple-team-edit-utils'

interface SimpleTeamDraft {
  bindMode: TaskType[]
  simpleExecutorMode: SimpleExecutorMode
  simpleCodingRuntime: CodingExecutorRuntime
  simpleCustomShellName: string
  simpleBotName: string
  simpleModelName: string
  simpleModelId: number | null
  simpleModelType: ModelTypeEnum | undefined
  simpleModelNamespace: string | undefined
  simplePrompt: string
  simpleInheritBaseCapabilities: boolean
  simpleSelectedSkills: string[]
  simpleSelectedSkillRefs: Record<string, SkillRefMeta>
  simplePreloadSkills: string[]
  simpleDefaultKnowledgeBaseRefs: KnowledgeBaseDefaultRef[]
  simpleMcpConfig: string
}

function buildDraft(bot: Bot | undefined, bindMode: TaskType[]): SimpleTeamDraft {
  const executor = resolveSimpleExecutorFromBot(bot)
  return {
    bindMode,
    simpleExecutorMode: executor.mode,
    simpleCodingRuntime: executor.codingRuntime,
    simpleCustomShellName: executor.customShellName,
    simpleBotName: bot?.name || '',
    simpleModelName: bot?.agent_config ? getModelFromConfig(bot.agent_config) : '',
    simpleModelId: null,
    simpleModelType: bot?.agent_config ? getModelTypeFromConfig(bot.agent_config) : undefined,
    simpleModelNamespace: bot?.agent_config
      ? getModelNamespaceFromConfig(bot.agent_config)
      : undefined,
    simplePrompt: bot?.system_prompt || '',
    simpleInheritBaseCapabilities: bot?.inherit_base_capabilities === true,
    simpleSelectedSkills: bot?.skills || [],
    simpleSelectedSkillRefs: bot?.skill_refs || {},
    simplePreloadSkills: bot?.preload_skills || [],
    simpleDefaultKnowledgeBaseRefs: bot?.default_knowledge_base_refs || [],
    simpleMcpConfig: stringifyMcpConfig(bot?.mcp_servers || {}),
  }
}

export function useSimpleTeamDraft() {
  const [draft, setDraft] = useState(() => buildDraft(undefined, []))
  // Explicit clears remain edits even when they match an initial empty value.
  const editedFields = useRef(new Set<keyof SimpleTeamDraft>())

  const setField = useCallback(
    <Key extends keyof SimpleTeamDraft>(
      key: Key,
      value: SetStateAction<SimpleTeamDraft[Key]>,
      { userEdited = true }: { userEdited?: boolean } = {}
    ) => {
      if (userEdited) editedFields.current.add(key)
      setDraft(current => {
        const nextValue = typeof value === 'function' ? value(current[key]) : value
        return Object.is(current[key], nextValue) ? current : { ...current, [key]: nextValue }
      })
    },
    []
  )

  const initialize = useCallback((values: SimpleTeamDraft, preserveEdited = false) => {
    const fieldsToPreserve = preserveEdited
      ? new Set(editedFields.current)
      : new Set<keyof SimpleTeamDraft>()
    if (!preserveEdited) editedFields.current.clear()
    setDraft(current => {
      const next = { ...values }
      const preserve = <Key extends keyof SimpleTeamDraft>(key: Key) => {
        next[key] = current[key]
      }
      fieldsToPreserve.forEach(preserve)
      return next
    })
  }, [])

  const initializeBotFields = useCallback(
    (
      bot: Bot | undefined,
      bindMode: TaskType[],
      { preserveEdited = false }: { preserveEdited?: boolean } = {}
    ) => {
      initialize(buildDraft(bot, bindMode), preserveEdited)
    },
    [initialize]
  )

  const initializeNewDraft = useCallback(
    (bindMode: TaskType[]) => {
      initialize({
        ...buildDraft(undefined, bindMode),
        simpleExecutorMode: 'complex',
        simpleInheritBaseCapabilities: true,
      })
    },
    [initialize]
  )

  const normalizeExecutor = useCallback((shells: UnifiedShell[]) => {
    // Normalize the latest draft so catalog hydration cannot be overwritten.
    setDraft(current => {
      const normalized = normalizeExecutorForBindMode(
        current.simpleExecutorMode,
        current.bindMode,
        shells,
        current.simpleCustomShellName,
        current.simpleCodingRuntime
      )
      if (
        normalized.mode === current.simpleExecutorMode &&
        normalized.codingRuntime === current.simpleCodingRuntime
      ) {
        return current
      }
      return {
        ...current,
        simpleExecutorMode: normalized.mode,
        simpleCodingRuntime: normalized.codingRuntime,
      }
    })
  }, [])

  const setBindMode = useCallback(
    (value: SetStateAction<TaskType[]>) => setField('bindMode', value),
    [setField]
  )

  return {
    draft,
    setField,
    setBindMode,
    initializeBotFields,
    initializeNewDraft,
    normalizeExecutor,
  }
}
