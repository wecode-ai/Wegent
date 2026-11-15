// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export type ProjectAgentMode = "existing" | "create";

export interface ProjectAgentOwnerOption {
  label: string;
  namespace: string;
}

export interface ProjectAgentConfigurationHost {
  requiresTemplateEnvironmentSelection?: boolean;
  resolveTemplateAgentRouting?(
    runtime: "codex" | "claude_code",
    location: "local" | "cloud",
    projectId?: string,
    environmentId?: string,
    model?: import("../agent-form/runnerRouting").RunnerModelIdentity,
  ): Promise<import("../templates/types").TemplateAgentRouting>;
  listTemplateAgentModels?(
    runtime: "codex" | "claude_code",
    projectId?: string,
  ): Promise<{
    models: import("../agent-form/runnerRouting").RunnerModel[];
  }>;
  listTemplateCloudAgentModels?(
    runtime: "codex" | "claude_code",
    projectId?: string,
  ): Promise<import("../agent-form/runnerRouting").RunnerModel[]>;
  listTemplateAgentEnvironments?(
    projectId: string,
  ): Promise<import("../types").CollaborationExecutionEnvironment[]>;
  templateAgentEnvironmentSettingsHref?(
    project: import("../types").CollaborationProject,
  ): string;

  createTemplateAgent?(
    agent: import("../templates/types").TemplateAgent,
    namespace: string,
    routing: import("../templates/types").TemplateAgentRouting,
  ): Promise<{ id: string; name: string }>;
  readTemplateAgent?(
    teamId: number,
  ): Promise<Omit<import("../templates/types").TemplateAgent, "key">>;

  /**
   * Whether the host lets the user pick an already existing Agent resource.
   * Defaults to true; hosts that only manage Agents through their own resource
   * library set it to false so the picker is never rendered.
   */
  supportsExistingAgentSelection?: boolean;
  renderAgentCreator?(props: {
    projectId?: string;
    namespace: string;
    onClose(): void;
    onCreated(agent: { name: string; teamId: number }): Promise<void>;
    ownerOptions?: ProjectAgentOwnerOption[];
    workspaceName: string;
  }): ReactNode;
  renderLocalAgentCreator?(props: {
    onClose(): void;
    onCreated(): Promise<void>;
    projectId?: string;
  }): ReactNode;
  /**
   * Edits the Agent resource behind a configured project Agent. Hosts that
   * cannot reach the resource library omit it and no edit action is rendered.
   */
  renderAgentEditor?(props: {
    projectId?: string;
    agent: { teamId: number };
    namespace: string;
    onClose(): void;
    onSaved(agent: { name: string; teamId: number }): Promise<void>;
    workspaceName: string;
  }): ReactNode;
  /** Edits a project-owned definition through its local or cloud storage API. */
  renderProjectAgentEditor?(props: {
    projectId?: string;
    resourceId: string;
    onClose(): void;
    onSaved(): Promise<void>;
  }): ReactNode;
  renderDialog(props: {
    busy: boolean;
    children: ReactNode;
    closeLabel: string;
    description: string;
    onClose(): void;
    testIds: {
      backdrop: string;
      close: string;
      dialog: string;
    };
    title: string;
  }): ReactNode;
}
