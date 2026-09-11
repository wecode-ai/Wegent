import type { ComponentType } from "react";
import type {
  AutomationEventSourceCatalogItem,
  AutomationEventCollectionMode,
  AutomationEventSourceType,
  AutomationProject,
  AutomationUiRule,
  AutomationUiRun,
} from "../automation";
import type { WorkspaceAutomationExecutionCatalog } from "../ports/SharedWorkspaceApi";

export interface AutomationIncomingHook {
  id: string;
  projectId: string;
  name: string;
  status: "active" | "disabled";
  sourceType: AutomationEventSourceType;
  collectionMode: AutomationEventCollectionMode;
  resource: {
    resourceType?: string;
    instanceUrl?: string | null;
    displayName?: string | null;
    path?: string | null;
    url?: string | null;
    externalId?: string | null;
  };
  webhookUrl: string | null;
  pollIntervalSeconds: number | null;
  credentialRef: string | null;
  health: {
    status?: "pending" | "healthy" | "error";
    checkedAt?: string;
    lastError?: string;
  };
  lastEventAt: string | null;
  nextPollAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationIncomingHookUiApi {
  list(projectId: string): Promise<AutomationIncomingHook[]>;
  create(
    projectId: string,
    input: {
      name: string;
      sourceType: AutomationEventSourceType;
      collectionMode: AutomationEventCollectionMode;
      resource: { url: string };
      pollIntervalSeconds: number | null;
      credentialRef: string | null;
    },
  ): Promise<AutomationIncomingHook>;
  update(
    projectId: string,
    hookId: string,
    input: {
      version: number;
      status?: "active" | "disabled";
    },
  ): Promise<AutomationIncomingHook>;
  rotate(projectId: string, hookId: string): Promise<AutomationIncomingHook>;
  remove(projectId: string, hookId: string): Promise<void>;
}

export interface AutomationUiProject extends AutomationProject {
  task_provider?: string | null;
  provider_config?: {
    domain?: string | null;
    repository?: string | null;
  } | null;
}

export interface AutomationRulesViewProps {
  rules: AutomationUiRule[];
  runs: AutomationUiRun[];
  loading?: boolean;
  error?: string;
  canManage?: boolean;
  projectTags?: string[];
  eventSourceCatalog?: AutomationEventSourceCatalogItem[];
  projectIncomingHookApi?: AutomationIncomingHookUiApi;
  projectId?: string;
  project?: AutomationUiProject;
  executionCatalog?: WorkspaceAutomationExecutionCatalog;
  onReload?: () => Promise<void>;
  onLoadExecutionCatalog?: () => Promise<WorkspaceAutomationExecutionCatalog>;
  onLoadExecutionPlugins?: (
    deviceIds: string[],
  ) => Promise<WorkspaceAutomationExecutionCatalog["plugins"]>;
  onLoadRuns?: () => Promise<AutomationUiRun[]>;
  onRunRule?: (rule: AutomationUiRule) => Promise<void>;
  onSaveRule?: (rule: AutomationUiRule) => Promise<AutomationUiRule>;
  onToggleRule?: (
    rule: AutomationUiRule,
    enabled: boolean,
  ) => Promise<AutomationUiRule>;
  onDuplicateRule?: (rule: AutomationUiRule) => Promise<AutomationUiRule>;
  onDeleteRule?: (rule: AutomationUiRule) => Promise<void>;
}

export const AutomationRulesView: ComponentType<AutomationRulesViewProps>;
