import type { ComponentType } from 'react'
import type { ProjectEventSourceCatalogItem } from '@/api/projectIncomingHooks'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { CloudProject } from '@/api/deliveries'
import type {
  AutomationExecutionCatalog,
  AutomationUiRule,
  AutomationUiRun,
} from './automationRuleBackend'

export interface AutomationRulesViewProps {
  rules: AutomationUiRule[]
  runs: AutomationUiRun[]
  loading?: boolean
  error?: string
  canManage?: boolean
  projectTags?: string[]
  eventSourceCatalog?: ProjectEventSourceCatalogItem[]
  projectIncomingHookApi?: ReturnType<typeof createProjectIncomingHookApi>
  projectId?: string
  project?: CloudProject
  executionCatalog?: AutomationExecutionCatalog
  onReload?: () => Promise<void>
  onLoadExecutionCatalog?: () => Promise<AutomationExecutionCatalog>
  onLoadExecutionPlugins?: () => Promise<AutomationExecutionCatalog['plugins']>
  onLoadRuns?: () => Promise<AutomationUiRun[]>
  onRunRule?: (rule: AutomationUiRule) => Promise<void>
  onSaveRule?: (rule: AutomationUiRule) => Promise<AutomationUiRule>
  onToggleRule?: (rule: AutomationUiRule, enabled: boolean) => Promise<AutomationUiRule>
  onDuplicateRule?: (rule: AutomationUiRule) => Promise<AutomationUiRule>
  onDeleteRule?: (rule: AutomationUiRule) => Promise<void>
}

export const AutomationRulesView: ComponentType<AutomationRulesViewProps>
