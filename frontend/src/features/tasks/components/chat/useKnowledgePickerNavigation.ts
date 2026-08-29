// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useReducer } from 'react'

import type { DingtalkDocNode } from '@/types/dingtalk-doc'
import type { KnowledgeBase } from '@/types/knowledge'
import type { ExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import type { ExternalKnowledgeBase, ExternalKnowledgeScope } from '@/types/external-knowledge'

export type KnowledgeSourceKey =
  | 'personal'
  | 'group'
  | 'organization'
  | 'dingtalk'
  | 'dingtalk:docs'
  | 'dingtalk:wikispace'
  | `external:${string}`

export interface ActiveInternalKnowledgeBase {
  source: 'internal'
  knowledgeBase: KnowledgeBase
}

export interface ActiveExternalKnowledgeBase {
  source: 'external'
  provider: ExternalKnowledgeSource
  knowledgeBase: ExternalKnowledgeBase
}

export type ActiveKnowledgeBase = ActiveInternalKnowledgeBase | ActiveExternalKnowledgeBase

type ExternalSourceKey = `external:${string}`
type DingTalkSectionKey = 'dingtalk:docs' | 'dingtalk:wikispace'

type KnowledgeBaseParent =
  | { source: 'personal' | 'organization' }
  | { source: 'group'; group: string }
  | { source: ExternalSourceKey; scope: ExternalKnowledgeScope }

type ExternalKnowledgeBaseParent = Extract<KnowledgeBaseParent, { source: ExternalSourceKey }>

type NavigationState =
  | { view: 'source'; source: KnowledgeSourceKey }
  | { view: 'group'; source: 'group'; group: string }
  | { view: 'external-scope'; source: ExternalSourceKey; scope: ExternalKnowledgeScope }
  | { view: 'dingtalk-section'; source: DingTalkSectionKey }
  | { view: 'knowledge-base'; parent: KnowledgeBaseParent; knowledgeBase: ActiveKnowledgeBase }
  | { view: 'dingtalk-space'; source: 'dingtalk:wikispace'; space: DingtalkDocNode }

type NavigationAction =
  | { type: 'select-source'; source: KnowledgeSourceKey }
  | { type: 'select-group'; group: string }
  | { type: 'select-external-scope'; providerId: string; scope: ExternalKnowledgeScope }
  | { type: 'select-dingtalk-section'; source: DingTalkSectionKey }
  | { type: 'open-internal-knowledge-base'; knowledgeBase: KnowledgeBase }
  | {
      type: 'open-external-knowledge-base'
      provider: ExternalKnowledgeSource
      knowledgeBase: ExternalKnowledgeBase
    }
  | { type: 'open-dingtalk-space'; space: DingtalkDocNode }
  | { type: 'back' }

const INITIAL_NAVIGATION_STATE: NavigationState = {
  view: 'source',
  source: 'personal',
}

function isExternalKnowledgeBaseParent(
  parent: KnowledgeBaseParent
): parent is ExternalKnowledgeBaseParent {
  return parent.source.startsWith('external:')
}

function getActiveSource(state: NavigationState): KnowledgeSourceKey {
  return state.view === 'knowledge-base' ? state.parent.source : state.source
}

function getInternalKnowledgeBaseParent(state: NavigationState): KnowledgeBaseParent {
  if (state.view === 'group') {
    return { source: 'group', group: state.group }
  }
  if (state.view === 'knowledge-base' && state.parent.source === 'group') {
    return state.parent
  }

  const source = getActiveSource(state)
  return source === 'organization' ? { source } : { source: 'personal' }
}

function getExternalKnowledgeBaseParent(
  state: NavigationState,
  provider: ExternalKnowledgeSource,
  knowledgeBase: ExternalKnowledgeBase
): KnowledgeBaseParent {
  if (state.view === 'external-scope') {
    return { source: state.source, scope: state.scope }
  }
  if (state.view === 'knowledge-base' && isExternalKnowledgeBaseParent(state.parent)) {
    return state.parent
  }

  return {
    source: `external:${provider.providerId}`,
    scope: knowledgeBase.scope ?? 'all',
  }
}

function navigateBack(state: NavigationState): NavigationState {
  if (state.view === 'knowledge-base') {
    if (state.parent.source === 'group') {
      return { view: 'group', source: 'group', group: state.parent.group }
    }
    if (isExternalKnowledgeBaseParent(state.parent)) {
      return {
        view: 'external-scope',
        source: state.parent.source,
        scope: state.parent.scope,
      }
    }
    return { view: 'source', source: state.parent.source }
  }
  if (state.view === 'dingtalk-space') {
    return { view: 'dingtalk-section', source: 'dingtalk:wikispace' }
  }
  if (state.view === 'dingtalk-section') {
    return { view: 'source', source: 'dingtalk' }
  }
  if (state.view === 'group') {
    return { view: 'source', source: 'group' }
  }
  if (state.view === 'external-scope') {
    return { view: 'source', source: state.source }
  }
  return state
}

function navigationReducer(state: NavigationState, action: NavigationAction): NavigationState {
  switch (action.type) {
    case 'select-source':
      return { view: 'source', source: action.source }
    case 'select-group':
      return { view: 'group', source: 'group', group: action.group }
    case 'select-external-scope':
      return {
        view: 'external-scope',
        source: `external:${action.providerId}`,
        scope: action.scope,
      }
    case 'select-dingtalk-section':
      return { view: 'dingtalk-section', source: action.source }
    case 'open-internal-knowledge-base':
      return {
        view: 'knowledge-base',
        parent: getInternalKnowledgeBaseParent(state),
        knowledgeBase: { source: 'internal', knowledgeBase: action.knowledgeBase },
      }
    case 'open-external-knowledge-base':
      return {
        view: 'knowledge-base',
        parent: getExternalKnowledgeBaseParent(state, action.provider, action.knowledgeBase),
        knowledgeBase: {
          source: 'external',
          provider: action.provider,
          knowledgeBase: action.knowledgeBase,
        },
      }
    case 'open-dingtalk-space':
      return { view: 'dingtalk-space', source: 'dingtalk:wikispace', space: action.space }
    case 'back':
      return navigateBack(state)
  }
}

export function useKnowledgePickerNavigation() {
  const [state, dispatch] = useReducer(navigationReducer, INITIAL_NAVIGATION_STATE)

  const selectSource = useCallback((source: KnowledgeSourceKey) => {
    dispatch({ type: 'select-source', source })
  }, [])
  const selectGroup = useCallback((group: string) => {
    dispatch({ type: 'select-group', group })
  }, [])
  const selectExternalScope = useCallback((providerId: string, scope: ExternalKnowledgeScope) => {
    dispatch({ type: 'select-external-scope', providerId, scope })
  }, [])
  const selectDingTalkSection = useCallback((source: DingTalkSectionKey) => {
    dispatch({ type: 'select-dingtalk-section', source })
  }, [])
  const openInternalKnowledgeBase = useCallback((knowledgeBase: KnowledgeBase) => {
    dispatch({ type: 'open-internal-knowledge-base', knowledgeBase })
  }, [])
  const openExternalKnowledgeBase = useCallback(
    (provider: ExternalKnowledgeSource, knowledgeBase: ExternalKnowledgeBase) => {
      dispatch({ type: 'open-external-knowledge-base', provider, knowledgeBase })
    },
    []
  )
  const openDingTalkSpace = useCallback((space: DingtalkDocNode) => {
    dispatch({ type: 'open-dingtalk-space', space })
  }, [])
  const back = useCallback(() => {
    dispatch({ type: 'back' })
  }, [])

  return {
    activeSource: getActiveSource(state),
    activeGroup:
      state.view === 'group'
        ? state.group
        : state.view === 'knowledge-base' && state.parent.source === 'group'
          ? state.parent.group
          : null,
    externalScope:
      state.view === 'external-scope'
        ? state.scope
        : state.view === 'knowledge-base' && isExternalKnowledgeBaseParent(state.parent)
          ? state.parent.scope
          : null,
    activeKnowledgeBase: state.view === 'knowledge-base' ? state.knowledgeBase : null,
    activeDingTalkSpace: state.view === 'dingtalk-space' ? state.space : null,
    selectSource,
    selectGroup,
    selectExternalScope,
    selectDingTalkSection,
    openInternalKnowledgeBase,
    openExternalKnowledgeBase,
    openDingTalkSpace,
    back,
  }
}
