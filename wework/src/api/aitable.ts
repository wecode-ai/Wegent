// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// DingTalk AI Table dynamic schema, record, and field APIs.
//
// Cloud projects call the backend-owned routes over HTTP; local projects call
// the Executor over IPC. Both return the same normalized shapes and always
// preserve the raw DingTalk payloads so unknown field types round-trip.

import type { CloudProject } from '@/api/deliveries'

export interface AITableField {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
  ai_config?: Record<string, unknown> | null
  raw: Record<string, unknown>
}

export interface AITableRecord {
  id: string
  cells: Record<string, unknown>
  raw: Record<string, unknown>
}

export interface AITableDescription {
  base: Record<string, unknown>
  tables: Array<Record<string, unknown>>
  active_table: Record<string, unknown>
  fields: AITableField[]
}

export interface AITableRecordPage {
  items: AITableRecord[]
  cursor: string | null
  has_more: boolean
}

export interface AITableApi {
  configureProject(project: CloudProject): Promise<void>
  describe(projectId: string): Promise<AITableDescription>
  listRecords(
    projectId: string,
    options?: { query?: string; limit?: number; cursor?: string }
  ): Promise<AITableRecordPage>
  getRecord?(projectId: string, recordId: string): Promise<AITableRecord>
  createRecord(projectId: string, cells: Record<string, unknown>): Promise<AITableRecord>
  updateRecord(
    projectId: string,
    recordId: string,
    cells: Record<string, unknown>
  ): Promise<AITableRecord>
  deleteRecord(projectId: string, recordId: string): Promise<void>
  createField(
    projectId: string,
    data: { name: string; type: string; config?: Record<string, unknown> }
  ): Promise<AITableField>
  updateField(
    projectId: string,
    fieldId: string,
    data: { name?: string; config?: Record<string, unknown> }
  ): Promise<AITableField>
  deleteField(projectId: string, fieldId: string): Promise<void>
}

type LocalRequest = <T>(
  method: string,
  params?: Record<string, unknown>,
  deviceId?: string
) => Promise<T>

export function createLocalAITableApi(request: LocalRequest): AITableApi {
  return {
    async configureProject(project) {
      await request('external_projects.configure', {
        project: {
          id: project.id,
          public_id: project.public_id,
          project_key: project.project_key,
          name: project.name,
          description: project.description,
          project_store: project.project_store,
          task_provider: project.task_provider,
          provider_config: project.provider_config,
          version: project.version,
        },
      })
    },
    describe(projectId) {
      return request('aitable.describe', { project_id: projectId })
    },
    listRecords(projectId, options = {}) {
      return request('aitable.list_records', {
        project_id: projectId,
        query: options.query,
        limit: options.limit,
        cursor: options.cursor,
      })
    },
    getRecord(projectId, recordId) {
      return request('aitable.get_record', { project_id: projectId, record_id: recordId })
    },
    createRecord(projectId, cells) {
      return request('aitable.create_record', { project_id: projectId, cells })
    },
    updateRecord(projectId, recordId, cells) {
      return request('aitable.update_record', {
        project_id: projectId,
        record_id: recordId,
        cells,
      })
    },
    async deleteRecord(projectId, recordId) {
      await request('aitable.delete_record', { project_id: projectId, record_id: recordId })
    },
    createField(projectId, data) {
      return request('aitable.create_field', {
        project_id: projectId,
        name: data.name,
        field_type: data.type,
        config: data.config ?? {},
      })
    },
    updateField(projectId, fieldId, data) {
      return request('aitable.update_field', {
        project_id: projectId,
        field_id: fieldId,
        field: data,
      })
    },
    async deleteField(projectId, fieldId) {
      await request('aitable.delete_field', { project_id: projectId, field_id: fieldId })
    },
  }
}
