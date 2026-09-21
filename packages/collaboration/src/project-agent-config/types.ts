// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export type ProjectAgentMode = "existing" | "create";

export interface ProjectAgentModeOption {
  description: string;
  label: string;
  testId: string;
  value: ProjectAgentMode;
}

export interface ProjectAgentSelectOption {
  label: string;
  value: string;
}

export interface ProjectAgentConfigurationHost {
  /**
   * Whether the host lets the user pick an already existing Agent resource.
   * Defaults to true; hosts that only manage Agents through their own resource
   * library set it to false so the picker is never rendered.
   */
  supportsExistingAgentSelection?: boolean;
  /**
   * Whether an Agent resource may be materialized into a project whose
   * storage location differs from the resource catalog's location.
   */
  supportsCrossLocationAgentSelection?: boolean;
  renderAgentCreator?(props: {
    namespace: string;
    onClose(): void;
    onCreated(agent: { name: string; teamId: number }): Promise<void>;
    workspaceName: string;
  }): ReactNode;
  renderLocalAgentCreator?(props: {
    onClose(): void;
    onCreated(): Promise<void>;
  }): ReactNode;
  /**
   * Edits the Agent resource behind a configured project Agent. Hosts that
   * cannot reach the resource library omit it and no edit action is rendered.
   */
  renderAgentEditor?(props: {
    agent: { teamId: number };
    namespace: string;
    onClose(): void;
    onSaved(agent: { name: string; teamId: number }): Promise<void>;
    workspaceName: string;
  }): ReactNode;
  renderLocalAgentEditor?(props: {
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
  renderModePicker(props: {
    onChange(value: ProjectAgentMode): void;
    options: ProjectAgentModeOption[];
    value: ProjectAgentMode;
  }): ReactNode;
  renderSelect(props: {
    ariaLabel: string;
    onChange(value: string): void;
    options: ProjectAgentSelectOption[];
    placeholder: string;
    testId: string;
    value: string;
  }): ReactNode;
  renderPrimaryAction(props: {
    children: ReactNode;
    disabled: boolean;
    onClick(): void;
    testId: string;
  }): ReactNode;
}
