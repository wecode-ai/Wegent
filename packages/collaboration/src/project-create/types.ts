// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

import type { WorkspaceProjectCreateInput } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationGroup,
  CollaborationGroupMember,
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
  collaborationGroupDraft: ProjectCreateCollaborationGroupDraft | null;
}

export interface ProjectCreateCollaborationGroupDraft {
  name: string;
  description: string;
  instructions: string;
  leader: CollaborationGroupMember;
  members: CollaborationGroupMember[];
  stages: Array<{
    id: string;
    name: string;
    description: string;
    assignee: CollaborationGroupMember | null;
  }>;
  executionRequirements: {
    requiredTags: string[];
  };
}

export interface ProjectCreateCollaborationGroupDraftInput {
  projectName: string;
  projectDescription: string;
  generationInstructions: string;
  currentUser: {
    id: number;
    name: string;
  };
  members: CollaborationMember[];
  agents: CollaborationOwnedAgent[];
  modelSelection: ProjectCreateGenerationModelSelection;
}

export interface ProjectCreateGenerationModelSelection {
  modelName: string;
  modelType?: "public" | "user" | "group" | "runtime" | null;
  options?: Record<string, string>;
}

export interface ProjectCreateGenerationModel extends ProjectCreateGenerationModelSelection {
  displayName: string;
}

export interface ProjectCreateGenerationModelCatalog {
  models: ProjectCreateGenerationModel[];
  defaultSelection: ProjectCreateGenerationModelSelection | null;
}

export type ProjectCreateGenerationProgressPhase = "preparing" | "generating";

export type ProjectCreateCollaborationGroupGenerationEvent =
  | {
      type: "group";
      name: string;
    }
  | {
      type: "participant_started";
      kind: "human" | "agent";
      id: string;
      leader: boolean;
    }
  | {
      type: "participant_delta";
      kind: "human" | "agent";
      id: string;
      delta: string;
    }
  | {
      type: "principle";
      text: string;
    }
  | {
      type: "stage";
      id: string;
      name: string;
    };

export interface ProjectCreateResourceSetup {
  location: ProjectCreateLocation;
  currentUser: {
    id: number;
    name: string;
  };
  members: CollaborationMember[];
  agents: CollaborationOwnedAgent[];
  defaultAgentResourceIds?: string[];
  groups: CollaborationGroup[];
  executionEnvironments?: CollaborationExecutionEnvironment[];
  loadCollaborationGroupGenerationModels?(): Promise<ProjectCreateGenerationModelCatalog>;
  generateCollaborationGroupDraft?(
    input: ProjectCreateCollaborationGroupDraftInput,
    onProgress?: (phase: ProjectCreateGenerationProgressPhase) => void,
    onEvent?: (event: ProjectCreateCollaborationGroupGenerationEvent) => void,
  ): Promise<ProjectCreateCollaborationGroupDraft>;
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
  locale: "zh-CN" | "en";
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
  publicAccessRole: string;
  viewerRole: string;
  developerRole: string;
  viewerRoleDescription: string;
  developerRoleDescription: string;
  defaultIssueSecurity: string;
  openIssueSecurity: string;
  relatedIssueSecurity: string;
  openIssueSecurityDescription: string;
  relatedIssueSecurityDescription: string;
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
  importGroupDescription: string;
  availableAgents: string;
  availableGroups: string;
  noAvailableCollaborators: string;
  groupRecommendationTitle: string;
  groupRecommendationDescription: string;
  keepDirectCollaboration: string;
  organizeAsGroup: string;
  createCollaborationGroup: string;
  generatingGroup: string;
  groupDraftTitle: string;
  groupName: string;
  groupLeader: string;
  leaderWorks: string;
  specialistWorks: string;
  setAsLeader: string;
  generatedWorkflow: string;
  editResponsibilities: string;
  supplementResponsibility: string;
  supplementAllocationPrinciples: string;
  removeGroup: string;
  applyGroup: string;
  groupGenerationUnavailable: string;
  generationModel: string;
  generationModelLoading: string;
  generationModelRequired: string;
  selectGenerationModel: string;
  generationRequest: string;
  generationRequestPlaceholder: string;
  generationRequestDefault: string;
  selectedGenerationAgents: string;
  agentAttachment: string;
  memberAttachment: string;
  standingInGroup: string;
  generateResponsibilities: string;
  preparingGenerationModel: string;
  generatingResponsibilities: string;
  generationElapsed: string;
  waitingForAssignment: string;
  automaticAssignmentHint: string;
  formingGroup: string;
  liveGeneration: string;
  allocationPrinciples: string;
  generatingWorkflow: string;
  groupSettingsHint: string;
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
