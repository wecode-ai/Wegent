// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { AgentDeleteAction } from "../agent-form/AgentDeleteDialog";

export type ProjectAgentMode = "existing" | "create";

export interface ProjectAgentOwnerOption {
  label: string;
  namespace: string;
}

export interface ProjectAgentConfigurationHost {
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
    deletion?: AgentDeleteAction;
    projectId?: string;
    agent: { teamId: number };
    namespace: string;
    onClose(): void;
    onSaved(agent: { name: string; teamId: number }): Promise<void>;
    workspaceName: string;
  }): ReactNode;
  renderLocalAgentEditor?(props: {
    deletion?: AgentDeleteAction;
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
