// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export type ProjectAgentMode = "wegent" | "codex";

export interface ProjectAgentModeOption {
  label: string;
  testId: string;
  value: ProjectAgentMode;
}

export interface ProjectAgentSelectOption {
  label: string;
  value: string;
}

export interface ProjectAgentConfigurationHost {
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
  renderTextControl(props: {
    ariaLabel: string;
    multiline?: boolean;
    onChange(value: string): void;
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
