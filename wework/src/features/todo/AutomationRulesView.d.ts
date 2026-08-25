import type { ComponentType } from 'react'
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
  executionCatalog?: AutomationExecutionCatalog
  onReload?: () => Promise<void>
  onSaveRule?: (rule: AutomationUiRule, published: boolean) => Promise<AutomationUiRule>
  onToggleRule?: (rule: AutomationUiRule, enabled: boolean) => Promise<AutomationUiRule>
  onDuplicateRule?: (rule: AutomationUiRule) => Promise<AutomationUiRule>
  onDeleteRule?: (rule: AutomationUiRule) => Promise<void>
  onRunRule?: (rule: AutomationUiRule) => Promise<AutomationUiRun>
}

export const AutomationRulesView: ComponentType<AutomationRulesViewProps>
