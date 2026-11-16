// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useRef, useState } from "react";

import type { CollaborationExecutionEnvironment } from "../types";

import {
  RepositoryProviderError,
  repositoryProviderConfig,
} from "./projectProviderConfig";
import type {
  DingTalkAITableLink,
  ProjectCreateDialogProps,
  ProjectCreateLocation,
  ProjectCreateProvider,
  ProjectCreateHostAdapter,
  ProjectCreateLabels,
} from "./types";

type ProjectVisibility = NonNullable<
  import("../ports/SharedWorkspaceApi").WorkspaceProjectCreateInput["visibility"]
>;

export function defaultExecutionEnvironmentDeviceIds(
  environments: CollaborationExecutionEnvironment[],
): number[] {
  const deviceIds = new Map<string, number>();
  for (const environment of environments) {
    const deviceId = environment.device_id;
    if (
      !environment.is_current_device ||
      environment.kind !== "local_device" ||
      environment.status !== "online" ||
      deviceId == null ||
      !Number.isSafeInteger(deviceId) ||
      deviceId <= 0
    ) {
      continue;
    }
    const identity = environment.device_key?.trim() || String(deviceId);
    if (!deviceIds.has(identity)) deviceIds.set(identity, deviceId);
  }
  return [...deviceIds.values()];
}

export function projectCreateErrorMessage(
  cause: unknown,
  labels: ProjectCreateLabels,
  host?: ProjectCreateHostAdapter,
): string {
  if (cause instanceof RepositoryProviderError) {
    return {
      repository_required: labels.repositoryRequired,
      repository_invalid: labels.repositoryInvalid,
      github_repository_invalid: labels.githubRepositoryInvalid,
      gitlab_repository_invalid: labels.gitlabRepositoryInvalid,
    }[cause.code];
  }
  return (
    host?.formatError?.(cause) ??
    (cause instanceof Error && cause.message
      ? cause.message
      : labels.createFailed)
  );
}

/** Keep template submission and its default device selection on the same readiness boundary. */
export function useProjectCreateController({
  targets,
  defaultLocation,
  host,
  labels,
  onCreated,
  resourceSetup,
  initialTemplate,
}: ProjectCreateDialogProps) {
  const initialLocation =
    targets.find((target) => target.location === defaultLocation)?.location ??
    targets[0]?.location ??
    "cloud";
  const [name, setName] = useState(
    initialTemplate?.spec.resources.collaboration.project.name ?? "",
  );
  const [description, setDescription] = useState(
    initialTemplate?.spec.resources.collaboration.project.description ?? "",
  );
  const [location, setLocation] =
    useState<ProjectCreateLocation>(initialLocation);
  const [taskProvider, setTaskProvider] =
    useState<ProjectCreateProvider>("local");
  const [visibility, setVisibility] = useState<ProjectVisibility>("private");
  const [publicAccessRole, setPublicAccessRole] = useState<"Viewer">("Viewer");
  const [defaultIssueSecurity, setDefaultIssueSecurity] = useState<
    "open" | "related"
  >("open");
  const [repositoryAddress, setRepositoryAddress] = useState("");
  const [token, setToken] = useState("");
  const [aitableUrl, setAitableUrl] = useState("");
  const [memberUserIds, setMemberUserIds] = useState<number[]>([]);
  const [agentResourceIds, setAgentResourceIds] = useState<string[]>([]);
  const defaultAgentResourceIds = resourceSetup?.defaultAgentResourceIds ?? [];
  const [selectedEnvironmentDeviceIds, setExecutionEnvironmentDeviceIds] =
    useState<number[] | null>(null);
  const executionEnvironmentDeviceIds =
    selectedEnvironmentDeviceIds ??
    defaultExecutionEnvironmentDeviceIds(
      resourceSetup?.executionEnvironments ?? [],
    );
  const [templateGroupDrafts, setTemplateGroupDrafts] = useState<
    import("./types").ProjectCreateCollaborationGroupDraft[]
  >([]);
  const [collaborationGroupDraft, setCollaborationGroupDraft] = useState<
    import("./types").ProjectCreateCollaborationGroupDraft | null
  >(null);
  const collaborationGroupDrafts = [
    ...templateGroupDrafts,
    ...(collaborationGroupDraft ? [collaborationGroupDraft] : []),
  ];
  const [templatePending, setTemplatePending] = useState(
    Boolean(initialTemplate?.spec.resources.collaboration.groups.length),
  );
  const [templateDocument, setTemplateDocument] = useState(
    initialTemplate ?? null,
  );
  const [createdProject, setCreatedProject] = useState<
    import("../types").CollaborationProject | null
  >(null);
  const createdProjectLocation = useRef(location);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repositoryProvider =
    taskProvider === "github" || taskProvider === "gitlab";
  const isAITableProvider = taskProvider === "dingtalk_aitable";
  const aitableLink = useMemo<DingTalkAITableLink | null>(
    () =>
      isAITableProvider && host?.parseDingTalkAITableLink
        ? host.parseDingTalkAITableLink(aitableUrl)
        : null,
    [aitableUrl, host, isAITableProvider],
  );
  const canSubmit =
    Boolean(
      createdProject ||
      (name.trim() &&
        !templatePending &&
        (!repositoryProvider || repositoryAddress.trim()) &&
        (!isAITableProvider || aitableLink) &&
        !saving),
    ) && !saving;

  async function submit() {
    if (!canSubmit) return;
    if (createdProject) {
      onCreated(createdProject, createdProjectLocation.current);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const target = targets.find(
        (candidate) => candidate.location === location,
      );
      if (!target) throw new Error(labels.unavailableLocation);
      const providerConfig = isAITableProvider
        ? {
            base_id: aitableLink!.baseId,
            table_id: aitableLink!.tableId,
            source_url: aitableLink!.url,
            ...(aitableLink!.viewId ? { view_id: aitableLink!.viewId } : {}),
          }
        : repositoryProvider
          ? {
              ...repositoryProviderConfig(repositoryAddress, taskProvider),
              ...(token.trim() ? { token: token.trim() } : {}),
            }
          : {};
      const participants = collaborationGroupDrafts.flatMap((group) => [
        group.leader,
        ...group.members,
      ]);
      const selection = {
        memberUserIds: [
          ...new Set([
            ...memberUserIds,
            ...participants
              .filter(
                (member) =>
                  member.kind === "human" &&
                  member.id !== String(resourceSetup?.currentUser.id),
              )
              .map((member) => Number(member.id)),
          ]),
        ],
        agentResourceIds: [
          ...new Set([
            ...agentResourceIds,
            ...participants
              .filter((member) => member.kind === "agent")
              .map((member) => member.id),
          ]),
        ],
        executionEnvironmentDeviceIds,
        collaborationGroupDrafts,
        ...(templateDocument ? { template: templateDocument } : {}),
      };
      await resourceSetup?.validate?.(selection);
      let project = await target.create({
        name: name.trim(),
        description: description.trim(),
        taskProvider,
        providerConfig,
        ...(location === "cloud"
          ? {
              visibility,
              ...(visibility === "public"
                ? { publicAccess: { role: publicAccessRole } }
                : {}),
              ...(!isAITableProvider ? { defaultIssueSecurity } : {}),
            }
          : {}),
        ...(location === "local" && resourceSetup
          ? {
              includeDefaultAgent: defaultAgentResourceIds.some((id) =>
                selection.agentResourceIds.includes(id),
              ),
            }
          : {}),
      });
      if (resourceSetup) {
        try {
          const configuredProject = await resourceSetup.configure(
            project,
            selection,
          );
          if (configuredProject) project = configuredProject;
        } catch (cause) {
          console.warn("[collaboration] Project configuration failed", {
            projectId: project.id,
            executionEnvironmentDeviceIds,
            environmentLoading: resourceSetup.executionEnvironmentLoading,
            environmentLoadFailed: Boolean(
              resourceSetup.executionEnvironmentError,
            ),
            currentDeviceIds: resourceSetup.executionEnvironments
              ?.filter((environment) => environment.is_current_device)
              .map((environment) => environment.device_id),
          });
          createdProjectLocation.current = location;
          setCreatedProject(project);
          throw new Error(
            labels.partialConfiguration +
              projectCreateErrorMessage(cause, labels, host),
            { cause },
          );
        }
      }
      host?.track?.("created");
      onCreated(project, location);
    } catch (cause) {
      host?.track?.("failed");
      setError(projectCreateErrorMessage(cause, labels, host));
    } finally {
      setSaving(false);
    }
  }

  return {
    state: {
      name,
      description,
      location,
      taskProvider,
      visibility,
      publicAccessRole,
      defaultIssueSecurity,
      repositoryAddress,
      token,
      aitableUrl,
      aitableLink,
      repositoryProvider,
      isAITableProvider,
      saving,
      createdProject,
      error,
      canSubmit,
      memberUserIds,
      agentResourceIds,
      executionEnvironmentDeviceIds,
      collaborationGroupDraft,
      collaborationGroupDrafts,
    },
    commands: {
      setTemplateDocument,
      setName,
      setDescription,
      setLocation,
      setTaskProvider,
      setVisibility,
      setPublicAccessRole,
      setDefaultIssueSecurity,
      setRepositoryAddress,
      setToken,
      setAitableUrl,
      setMemberUserIds,
      setAgentResourceIds,
      setExecutionEnvironmentDeviceIds,
      setCollaborationGroupDraft,
      setTemplateGroupDrafts,
      setTemplatePending,
      clearError: () => setError(null),
      submit,
    },
  };
}
