/** Shared rule contract. Source credentials and messages never belong to project state. */
export type AutomationSchedule =
  | { type: "cron"; expression: string }
  | { type: "interval"; value: number; unit: "minutes" | "hours" | "days" }
  | { type: "one_time"; executeAt: string };

export interface ConnectionHandlingPolicy {
  enabled?: boolean;
  automatic: boolean;
  askBeforeAct: boolean;
  immediate?: boolean;
}

export interface ConnectionRuleCondition {
  contains?: string;
  senderId?: string;
}

export interface ConnectionRuleProcessing {
  condition?: ConnectionRuleCondition;
  instruction?: string;
}

export interface AutomationConnectionResource extends Record<string, unknown> {
  providerId: string;
  id: string;
  profile: string;
  kind: string;
  name: string;
  scope?: "all";
}

export interface AutomationConnectionProvider {
  id: string;
  displayName: string;
  resourceKinds: string[];
  resourceLabels?: Record<string, string>;
  eventTypes?: string[];
  availability: { status: string; code?: string };
}

export interface ConnectionProjectTarget {
  id: string;
  store: "local" | "cloud";
}

export interface ConnectionAutomationRule extends ConnectionRuleProcessing {
  id: string;
  version: number;
  name: string;
  enabled: boolean;
  source: AutomationConnectionResource;
  eventType: string;
  project: ConnectionProjectTarget;
  targetKind: "human" | "agent" | "collaboration_group";
  targetId: string;
  runnerSelection?: import("../agent-form/runnerRouting").RunnerSelection;
  /** Explicitly authored publication instructions, processed privately before dispatch. */
  publication: { title: string; instruction: string };
  deviceId?: string;
  lastRunStatus?: string;
  collectionError?: string;
  cloudSyncError?: string;
  cloudRuleId?: string;
  cloudRuleVersion?: number;
  sharedRuleVersion?: number;
}

export interface ConnectionRuleRun {
  id: string;
  ruleId: string;
  status: "pending" | "delivered" | "published" | "failed" | "cancelled";
  createdAt: string;
  error?: string | null;
  issueId?: string | null;
  projectRunId?: string | null;
  retryable?: boolean | null;
}

export interface ConnectionRulesApi {
  /** Stable private-view boundary, never an authorization credential. */
  readonly ownerScope: string;
  list(project: ConnectionProjectTarget): Promise<ConnectionAutomationRule[]>;
  save(rule: ConnectionAutomationRule): Promise<ConnectionAutomationRule>;
  remove(id: string, version: number): Promise<void>;
  runs(id: string): Promise<ConnectionRuleRun[]>;
  retry(id: string): Promise<void>;
  retrySource?(id: string): Promise<void>;
  providers(): Promise<AutomationConnectionProvider[]>;
  resources(
    providerId: string,
    kind: string,
    query: string,
  ): Promise<AutomationConnectionResource[]>;
}
