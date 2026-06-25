// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useSyncExternalStore } from 'react'
import type React from 'react'

export interface KnowledgeSourceView {
  id: string
  label: string
  icon?: React.ReactNode
  getKnowledgeBaseCount?: () => Promise<number>
  renderView: () => React.ReactNode
}

const sourceViews = new Map<string, KnowledgeSourceView>()
const listeners = new Set<() => void>()
let snapshot: KnowledgeSourceView[] = []

function emitChange() {
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return snapshot
}

export function registerKnowledgeSourceView(id: string, view: KnowledgeSourceView): void {
  if (!id || typeof view?.renderView !== 'function') return
  sourceViews.set(id, { ...view, id })
  snapshot = Array.from(sourceViews.values())
  emitChange()
}

export function getKnowledgeSourceView(id: string): KnowledgeSourceView | undefined {
  return sourceViews.get(id)
}

export function listKnowledgeSourceViews(): KnowledgeSourceView[] {
  return [...snapshot]
}

export function useKnowledgeSourceViews(): KnowledgeSourceView[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
