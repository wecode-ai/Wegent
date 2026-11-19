// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useRef, useState, type SetStateAction } from "react";

import type { CollaborationExecutionEnvironment } from "../types";
import { ProjectCreateMembersError } from "./configureProjectMembers";

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
  ProjectCreateResourceSelection,
  ProjectCreateResourceSetup,
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

export function projectCreateNameErrorMessage(
  cause: unknown,
  labels: ProjectCreateLabels,
  count: number,
): string | null {
  if (!cause || typeof cause !== "object") return null;
  const error = cause as { status?: unknown; detail?: unknown };
  if (error.status !== 422 || !error.detail || typeof error.detail !== "object")
    return null;
  const errors = (error.detail as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;
  for (const item of errors) {
    if (!item || typeof item !== "object" || !Array.isArray(item.loc)) continue;
    if (
      item.loc.length !== 2 ||
      item.loc[0] !== "body" ||
      item.loc[1] !== "name"
    )
      continue;
    const max =
      item.ctx && typeof item.ctx === "object"
        ? item.ctx.max_length
        : undefined;
    if (
      item.type === "string_too_long" &&
      Number.isSafeInteger(max) &&
      max > 0
    ) {
      return labels.nameTooLong
        .replace("{max}", String(max))
        .replace("{count}", String(count));
    }
    if (typeof item.msg === "string" && item.msg.trim()) return item.msg;
  }
  return null;
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
  const pendingMemberSetup = useRef<{
    project: import("../types").CollaborationProject;
    location: ProjectCreateLocation;
    selection: ProjectCreateResourceSelection;
    setup: ProjectCreateResourceSetup;
  } | null>(null);
  const submissionInFlight = useRef(false);
  const submissionComplete = useRef(false);
  const [memberFailures, setMemberFailures] = useState<
    ProjectCreateMembersError["failures"]
  >([]);
  const [confirmedMembers, setConfirmedMembers] = useState<
    ProjectCreateMembersError["members"]
  >([]);
  const [memberSetupFailed, setMemberSetupFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [serverNameError, setServerNameError] = useState<{
    name: string;
    location: ProjectCreateLocation;
    message: string;
  } | null>(null);
  const nameLength = Array.from(name.trim()).length;
  const nameMaxLength = location === "cloud" ? 100 : 255;
  const currentServerNameError =
    serverNameError?.name === name.trim() &&
    serverNameError.location === location
      ? serverNameError.message
      : null;
  const nameError =
    nameLength > nameMaxLength
      ? labels.nameTooLong
          .replace("{max}", String(nameMaxLength))
          .replace("{count}", String(nameLength))
      : currentServerNameError;
  const submitErrorField = currentServerNameError
    ? ("name" as const)
    : repositoryError
      ? ("repository" as const)
      : null;
  const defaultEnvironmentIds = new Set(
    defaultExecutionEnvironmentDeviceIds(
      resourceSetup?.executionEnvironments ?? [],
    ),
  );
  const selectedEnvironmentIds =
    selectedEnvironmentDeviceIds === null
      ? null
      : new Set(selectedEnvironmentDeviceIds);
  const environmentSelectionChanged =
    selectedEnvironmentIds !== null &&
    (selectedEnvironmentIds.size !== defaultEnvironmentIds.size ||
      [...selectedEnvironmentIds].some((id) => !defaultEnvironmentIds.has(id)));
  const hasDraft =
    !createdProject &&
    Boolean(
      name.trim() ||
      description.trim() ||
      location !== initialLocation ||
      taskProvider !== "local" ||
      visibility !== "private" ||
      defaultIssueSecurity !== "open" ||
      repositoryAddress ||
      token ||
      aitableUrl ||
      memberUserIds.length ||
      agentResourceIds.length ||
      templateDocument ||
      collaborationGroupDrafts.length ||
      environmentSelectionChanged,
    );
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
        !nameError &&
        !repositoryError &&
        !templatePending &&
        (!repositoryProvider || repositoryAddress.trim()) &&
        (!isAITableProvider || aitableLink) &&
        !saving),
    ) && !saving;

  async function submit() {
    if (!canSubmit || submissionInFlight.current || submissionComplete.current)
      return;
    if (createdProject && !pendingMemberSetup.current) {
      submissionComplete.current = true;
      onCreated(createdProject, createdProjectLocation.current);
      return;
    }
    submissionInFlight.current = true;
    setSaving(true);
    setError(null);
    setMemberFailures([]);
    setRepositoryError(null);
    setServerNameError(null);
    try {
      const pending = pendingMemberSetup.current;
      const setup =
        pending?.setup ??
        (resourceSetup?.location === location ? resourceSetup : undefined);
      const projectLocation = pending?.location ?? location;
      const target = targets.find(
        (candidate) => candidate.location === projectLocation,
      );
      if (!target && !pending) throw new Error(labels.unavailableLocation);
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
      const selection: ProjectCreateResourceSelection = pending?.selection ?? {
        memberUserIds: [
          ...new Set([
            ...memberUserIds,
            ...participants
              .filter(
                (member) =>
                  member.kind === "human" &&
                  member.id !== String(setup?.currentUser.id),
              )
              .map((member) => Number(member.id)),
          ]),
        ].filter((userId) => userId !== setup?.currentUser.id),
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
      if (!pending) await setup?.validate?.(selection);
      let project =
        pending?.project ??
        (await target!.create({
          name: name.trim(),
          description: description.trim(),
          taskProvider,
          providerConfig,
          ...(location === "cloud"
            ? {
                visibility,
                ...(visibility === "public"
                  ? { publicAccess: { role: "Viewer" } }
                  : {}),
                ...(!isAITableProvider ? { defaultIssueSecurity } : {}),
              }
            : {}),
          ...(location === "local" && setup
            ? {
                includeDefaultAgent: defaultAgentResourceIds.some((id) =>
                  selection.agentResourceIds.includes(id),
                ),
              }
            : {}),
        }));
      if (setup) {
        try {
          const configuredProject = await setup.configure(project, selection);
          if (configuredProject) project = configuredProject;
        } catch (cause) {
          console.warn("[collaboration] Project configuration failed", {
            projectId: project.id,
            executionEnvironmentDeviceIds,
            environmentLoading: setup.executionEnvironmentLoading,
            environmentLoadFailed: Boolean(setup.executionEnvironmentError),
            currentDeviceIds: setup.executionEnvironments
              ?.filter((environment) => environment.is_current_device)
              .map((environment) => environment.device_id),
          });
          createdProjectLocation.current = projectLocation;
          setCreatedProject(project);
          if (cause instanceof ProjectCreateMembersError) {
            pendingMemberSetup.current = {
              project,
              location: projectLocation,
              selection,
              setup,
            };
            setMemberSetupFailed(true);
            setMemberFailures(cause.failures);
            setConfirmedMembers(cause.members);
          } else {
            pendingMemberSetup.current = null;
            setMemberSetupFailed(false);
          }
          throw new Error(
            (cause instanceof ProjectCreateMembersError
              ? labels.projectCreatedSetupPending + " "
              : labels.partialConfiguration) +
              projectCreateErrorMessage(cause, labels, host),
            { cause },
          );
        }
      }
      pendingMemberSetup.current = null;
      submissionComplete.current = true;
      host?.track?.("created");
      onCreated(project, projectLocation);
    } catch (cause) {
      host?.track?.("failed");
      const fieldError = projectCreateNameErrorMessage(
        cause,
        labels,
        nameLength,
      );
      if (cause instanceof RepositoryProviderError) {
        setRepositoryError(projectCreateErrorMessage(cause, labels, host));
        setError(null);
      } else if (fieldError) {
        setServerNameError({
          name: name.trim(),
          location,
          message: fieldError,
        });
        setError(null);
      } else {
        setError(projectCreateErrorMessage(cause, labels, host));
      }
    } finally {
      submissionInFlight.current = false;
      setSaving(false);
    }
  }

  return {
    state: {
      name,
      nameError,
      nameMaxLength,
      nameLength,
      submitErrorField,
      hasDraft,
      description,
      location,
      taskProvider,
      visibility,
      defaultIssueSecurity,
      repositoryAddress,
      repositoryError,
      token,
      aitableUrl,
      aitableLink,
      repositoryProvider,
      isAITableProvider,
      saving,
      createdProject,
      memberSetupFailed,
      memberFailures,
      confirmedMembers,
      error,
      canSubmit,
      memberUserIds,
      agentResourceIds,
      executionEnvironmentDeviceIds,
      collaborationGroupDraft,
      collaborationGroupDrafts,
      templateDocument,
    },
    commands: {
      setTemplateDocument,
      setName: (value: SetStateAction<string>) => {
        setName(value);
        setServerNameError(null);
      },
      setDescription,
      setLocation: (value: SetStateAction<ProjectCreateLocation>) => {
        setLocation(value);
        setServerNameError(null);
      },
      setTaskProvider: (value: SetStateAction<ProjectCreateProvider>) => {
        setTaskProvider(value);
        setRepositoryError(null);
      },
      setVisibility,
      setDefaultIssueSecurity,
      setRepositoryAddress: (value: SetStateAction<string>) => {
        setRepositoryAddress(value);
        setRepositoryError(null);
      },
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
