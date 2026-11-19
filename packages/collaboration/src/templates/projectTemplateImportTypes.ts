// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export type TemplateImportStepKind = 'agent' | 'group' | 'automation' | 'board'

export interface TemplateImportContext {
  operationId: string
  stepKey: string
}

export interface TemplateImportStep {
  key: string
  kind: TemplateImportStepKind
  resourceId?: string
}

export interface TemplateImportBegin {
  protocolVersion: 1
  intent: Record<string, unknown>
  steps: Array<Pick<TemplateImportStep, 'key' | 'kind'>>
}

export interface TemplateImportOperation {
  id: string
  projectId: string
  protocolVersion: 1
  status: 'pending' | 'completed'
  steps: TemplateImportStep[]
  intent?: Record<string, unknown>
}

export interface SharedWorkspaceTemplateImportsApi {
  supports?(projectId: string): Promise<boolean>
  begin(projectId: string, input: TemplateImportBegin): Promise<TemplateImportOperation>
  get(projectId: string, operationId: string): Promise<TemplateImportOperation>
  list(projectId: string): Promise<TemplateImportOperation[]>
}

export interface TemplateProjectConfigurationOptions {
  isCompleted?(kind: 'automation' | 'board'): boolean
  context?(kind: 'automation' | 'board'): TemplateImportContext
  boardId?(part: string): string
  onStepCompleted?(kind: 'automation' | 'board', resourceId: string): Promise<void>
}
