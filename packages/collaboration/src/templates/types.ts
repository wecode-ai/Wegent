// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationGroupMember } from '../types'

export interface TemplateRole {
  key: string
  name: string
  responsibility: string
  defaultKind?: 'human' | 'agent'
}

export interface TemplateStage {
  key: string
  name: string
  description: string
  ownerRole: string | null
  deliverables: string[]
  acceptance: string
}

export interface TemplateGroup {
  key: string
  name: string
  description: string
  instructions: string
  leaderRole: string
  roles: TemplateRole[]
  stages: TemplateStage[]
  executionRequirements: { requiredTags: string[] }
}

/** Portable configuration. Account ownership and resource bindings are not imported. */
export interface CollaborationTemplate {
  apiVersion: 'agent.wecode.io/v1'
  kind: 'Template'
  metadata: { name: string; namespace: string }
  spec: {
    category: 'collaboration'
    displayName: string
    description: string
    version: string
    resources: {
      collaboration: {
        project: {
          name: string
          description: string
          taskAssignment?: {
            enabled: boolean
            groupKey: string
            tags?: string[]
            priorities?: string[]
          }
          board?: { name: string; tags: string[] }
        }
        groups: TemplateGroup[]
      }
    }
  }
}

export interface TemplateRecord {
  id: number | null
  ownerId: number
  document: CollaborationTemplate
  revision: string | null
  source: 'builtin' | 'downloaded' | 'personal'
  pendingSync?: boolean
  syncError?: string
}

export interface TemplateListing {
  id: number
  resource_type: 'template'
  name: string
  display_name: string
  description?: string | null
  publisher_user_id: number
  publisher_namespace: string
  is_installed: boolean
  current_version?: { version: string } | null
}

export interface TemplateSummary {
  id: number
  ownerId: number
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
  revision: string
}

export interface CollaborationTemplateRemote {
  list(): Promise<TemplateSummary[]>
  discover(input?: { keyword?: string; cursor?: string }): Promise<{
    items: TemplateListing[]
    hasMore: boolean
    nextCursor: string | null
  }>
  get(id: number): Promise<TemplateRecord>
  save(document: CollaborationTemplate, revision: string | null): Promise<TemplateRecord>
  install(id: number): Promise<void>
  publish(id: number, version: string): Promise<void>
}

export interface TemplatePersistence {
  read(): Promise<TemplateRecord[]>
  write(records: TemplateRecord[]): Promise<void>
}

export interface CollaborationTemplateLibrary {
  /** Includes backend and account identity; changing it must remount scoped consumers. */
  scope: string
  ownerId: number
  remote?: CollaborationTemplateRemote
  persistence: TemplatePersistence
}

export type TemplateRoleAssignments = Record<string, Record<string, CollaborationGroupMember>>

export function templateIdentity(record: TemplateRecord): string {
  return `${record.ownerId}:${record.document.metadata.namespace}:${record.document.metadata.name}`
}
