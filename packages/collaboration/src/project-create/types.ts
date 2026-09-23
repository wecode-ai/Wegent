// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

import type { WorkspaceProjectCreateInput } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationGroup,
  CollaborationExecutionEnvironment,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationProject,
} from "../types";

export type ProjectCreateLocation = "local" | "cloud";
export type ProjectCreateProvider = NonNullable<
  WorkspaceProjectCreateInput["taskProvider"]
>;

export interface ProjectCreateTarget {
  location: ProjectCreateLocation;
  create(input: WorkspaceProjectCreateInput): Promise<CollaborationProject>;
}

export interface ProjectCreateResourceSelection {
  memberUserIds: number[];
  agentResourceIds: string[];
  executionEnvironmentDeviceIds: number[];
  leaderId: string;
}

export interface ProjectCreateResourceSetup {
  location: ProjectCreateLocation;
  currentUser: {
    id: number;
    name: string;
  };
  members: CollaborationMember[];
  agents: CollaborationOwnedAgent[];
  groups: CollaborationGroup[];
  executionEnvironments?: CollaborationExecutionEnvironment[];
  createDefaultAgent?(): Promise<string>;
  configure(
    project: CollaborationProject,
    selection: ProjectCreateResourceSelection,
  ): Promise<void>;
}

export interface DingTalkAITableLink {
  baseId: string;
  tableId: string;
  viewId?: string;
  url: string;
}

export interface ProjectCreateModalProps {
  title: string;
  children: ReactNode;
  onClose(): void;
}

export interface ProjectCreateHostAdapter {
  renderModal?(props: ProjectCreateModalProps): ReactNode;
  parseDingTalkAITableLink?(value: string): DingTalkAITableLink | null;
  formatError?(cause: unknown): string;
  track?(event: "created" | "failed"): void;
}

export interface ProjectCreateLabels {
  title: string;
  name: string;
  namePlaceholder: string;
  location: string;
  locationImmutable: string;
  localLocation: string;
  localLocationDescription: string;
  cloudLocation: string;
  cloudLocationDescription: string;
  visibility: string;
  privateVisibility: string;
  privateVisibilityDescription: string;
  restrictedVisibility: string;
  restrictedVisibilityDescription: string;
  publicVisibility: string;
  publicVisibilityDescription: string;
  publicVisibilityNotice: string;
  taskProvider: string;
  advancedSettings: string;
  builtInProvider: string;
  builtInLocalDescription: string;
  builtInCloudDescription: string;
  githubDescription: string;
  gitlabDescription: string;
  aitableProvider: string;
  aitableDescription: string;
  repository: string;
  repositoryHint: string;
  token: string;
  optional: string;
  privateRepositoryToken: string;
  cloudTokenHint: string;
  localTokenHint: string;
  aitableUrl: string;
  aitablePlaceholder: string;
  aitableInvalid: string;
  aitableHint: string;
  aitableRuntimeHint: string;
  description: string;
  descriptionPlaceholder: string;
  collaborators: string;
  currentUser: string;
  addCollaborator: string;
  createDefaultAgent: string;
  defaultGroupName: string;
  createDefaultAgentDescription: string;
  importGroupDescription: string;
  availableAgents: string;
  availableGroups: string;
  noAvailableCollaborators: string;
  cancel: string;
  create: string;
  creating: string;
  unavailableLocation: string;
  repositoryRequired: string;
  repositoryInvalid: string;
  githubRepositoryInvalid: string;
  gitlabRepositoryInvalid: string;
  createFailed: string;
}

export interface ProjectCreateDialogProps {
  targets: ProjectCreateTarget[];
  defaultLocation: ProjectCreateLocation;
  allowDingTalkAITable: boolean;
  labels: ProjectCreateLabels;
  workspaceContext?: {
    name: string;
    owner: string;
  };
  resourceSetup?: ProjectCreateResourceSetup;
  testIds?: {
    name?: string;
    description?: string;
    confirm?: string;
  };
  host?: ProjectCreateHostAdapter;
  onClose(): void;
  onCreated(
    project: CollaborationProject,
    location: ProjectCreateLocation,
  ): void;
}
