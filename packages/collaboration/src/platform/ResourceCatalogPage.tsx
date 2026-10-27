// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronRight,
  Cloud,
  FolderOpen,
  Monitor,
  Plus,
  Search,
  Settings,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import type { CollaborationTranslate } from "../i18n";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationGroup,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceMember,
} from "../types";
import type {
  CollaborationDomain,
  CollaborationPlatformHostAdapter,
} from "./types";
import type { DeviceCatalogState } from "./useDeviceCatalog";
import { DeviceCatalogFeedback } from "./DeviceCatalogFeedback";
import {
  ResourceDestinationDialog,
  type ResourceDestinationOption,
} from "./ResourceDestinationDialog";
import type { PlatformMessages } from "./platformMessages";
import {
  runtimeLabel,
  type ResourceCatalogKind,
  type ResourceScope,
  type ResourceSource,
} from "./resourceCatalogModel";

export function ResourceCatalogPage({
  api,
  domain,
  cloudAccess,
  kind,
  agents,
  groups,
  environments,
  deviceCatalog,
  translate,
  canCreateDevice,
  workspaces,
  projects,
  ownerOptions,
  messages,
  onAddToWorkspace,
  onCreateAgent,
  onCreateDevice,
  onCreateLocalAgent,
  onCreateTeam,
  onDeleteAgent,
  onDeleteTeam,
  onManageResource,
}: {
  api: SharedWorkspaceApi;
  domain: CollaborationDomain;
  kind: ResourceCatalogKind;
  cloudAccess: CollaborationPlatformHostAdapter["cloudAccess"];
  agents: CollaborationOwnedAgent[];
  groups: CollaborationGroup[];
  environments: CollaborationExecutionEnvironment[];
  deviceCatalog?: DeviceCatalogState;
  translate: CollaborationTranslate;
  canCreateDevice: boolean;
  workspaces: CollaborationWorkspace[];
  projects: CollaborationProject[];
  ownerOptions: CollaborationPlatformHostAdapter["workspaceOwnerOptions"];
  messages: PlatformMessages;
  onAddToWorkspace(
    workspaceId: string,
    kind: ResourceCatalogKind,
    resourceId: string,
  ): Promise<void>;
  onCreateAgent(
    ownerOptions: Array<{ namespace: string; label: string }>,
  ): void;
  onCreateDevice(source: ResourceSource, workspaceId?: string): void;
  onCreateLocalAgent(): void;
  onCreateTeam(workspaceId: string): void;
  onDeleteAgent(agent: CollaborationOwnedAgent): Promise<void>;
  onDeleteTeam(group: CollaborationGroup): Promise<void>;
  onManageResource(
    kind: ResourceCatalogKind,
    resourceId?: string,
    source?: ResourceSource,
  ): void;
}) {
  const [workspaceMembers, setWorkspaceMembers] = useState<
    Record<string, CollaborationWorkspaceMember[]>
  >({});
  useEffect(() => {
    let active = true;
    if (kind !== "teams" || !api.workspaces) return;
    void Promise.all(
      workspaces.map(
        async (workspace) =>
          [
            workspace.id,
            await api.workspaces!.listMembers(workspace.id),
          ] as const,
      ),
    )
      .then((entries) => {
        if (active) setWorkspaceMembers(Object.fromEntries(entries));
      })
      .catch(() => {
        if (active) setWorkspaceMembers({});
      });
    return () => {
      active = false;
    };
  }, [api, kind, workspaces]);
  const participantName = (
    member: CollaborationGroup["leader"],
    workspaceId: string,
  ) => {
    if (member.kind === "agent") {
      const agent = agents.find(
        (candidate) =>
          candidate.id === member.id ||
          String(candidate.team_id ?? "") === member.id ||
          candidate.agent_id === member.id,
      );
      return agent?.name ?? messages.agent;
    }
    return (
      workspaceMembers[workspaceId]?.find(
        (person) => String(person.user_id) === member.id,
      )?.user_name ?? messages.human
    );
  };
  const [scope, setScope] = useState<ResourceScope>("all");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [bindingResourceId, setBindingResourceId] = useState<string | null>(
    null,
  );
  const [bindingWorkspaceId, setBindingWorkspaceId] = useState<string | null>(
    null,
  );
  const [deletingAgent, setDeletingAgent] =
    useState<CollaborationOwnedAgent | null>(null);
  const [deletingTeam, setDeletingTeam] = useState<CollaborationGroup | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const workspaceLocations = useMemo(
    () =>
      new Map(
        workspaces.map((workspace) => [workspace.id, workspace.location]),
      ),
    [workspaces],
  );
  const localWorkspace =
    workspaces.find((workspace) => workspace.location === "local") ?? null;
  const cloudWorkspaces = workspaces.filter(
    (workspace) => workspace.location === "cloud",
  );
  const cloudGroupWorkspaces = cloudWorkspaces.filter(
    (workspace) => workspace.namespace !== "default",
  );
  const resourceOwners = Array.from(
    new Map([
      ["default", { namespace: "default", label: messages.cloudPersonal }],
      ...cloudGroupWorkspaces.map(
        (workspace) =>
          [
            workspace.namespace,
            { namespace: workspace.namespace, label: workspace.name },
          ] as const,
      ),
      ...(ownerOptions ?? [])
        .filter((owner) => owner.namespace !== "default")
        .map((owner) => [owner.namespace, owner] as const),
    ]).values(),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const createOptions: ResourceDestinationOption[] = [];
  if (domain === "cloud" && cloudAccess && !cloudAccess.authenticated) {
    createOptions.push({
      id: "cloud-login",
      testId: `collaboration-${kind}-create-cloud-login`,
      label: messages.loginForCloud,
      description: messages.loginForCloudHint,
      icon: <Cloud aria-hidden="true" />,
      onSelect: cloudAccess.requestLogin,
    });
  } else if (domain === "cloud" && kind === "devices") {
    createOptions.push({
      id: "default",
      testId: "collaboration-devices-create-cloud-personal",
      label: messages.cloudPersonal,
      description: messages.cloudPersonalHint,
      icon: <UserRound aria-hidden="true" />,
      onSelect: () => onCreateDevice("cloud"),
    });
    if (cloudGroupWorkspaces.length) {
      createOptions.push({
        id: "cloud-groups",
        testId: "collaboration-devices-create-cloud-groups",
        label: messages.cloudGroups,
        description: messages.cloudGroupsHint,
        icon: <UsersRound aria-hidden="true" />,
        children: cloudGroupWorkspaces.map((workspace) => ({
          id: workspace.id,
          testId: `collaboration-devices-create-workspace-${workspace.id}`,
          label: workspace.name,
          description: messages.cloudTeamHint,
          icon: <UsersRound aria-hidden="true" />,
          onSelect: () => onCreateDevice("cloud", workspace.id),
        })),
      });
    }
  } else if (domain === "cloud" && kind === "agents") {
    createOptions.push({
      id: "cloud",
      testId: "collaboration-agents-create-cloud",
      label: messages.cloudResources,
      description: messages.cloudResourcesHint,
      icon: <Cloud aria-hidden="true" />,
      onSelect: () => onCreateAgent(resourceOwners),
    });
  } else if (domain === "cloud") {
    const ownerDestinationOptions = resourceOwners.map((owner) => {
      const personal = owner.namespace === "default";
      const workspace = cloudWorkspaces.find(
        (candidate) => candidate.namespace === owner.namespace,
      );
      const disabled = kind === "teams" && !workspace;
      return {
        id: owner.namespace,
        testId: personal
          ? `collaboration-${kind}-create-cloud-personal`
          : kind === "teams" && workspace
            ? `collaboration-teams-create-workspace-${workspace.id}`
            : `collaboration-${kind}-create-owner-${owner.namespace}`,
        label: owner.label,
        description: disabled
          ? messages.teamSpaceRequired
          : personal
            ? messages.cloudPersonalHint
            : messages.cloudTeamHint,
        icon: personal ? (
          <UserRound aria-hidden="true" />
        ) : (
          <UsersRound aria-hidden="true" />
        ),
        disabled,
        onSelect: () => {
          if (kind === "teams" && workspace) onCreateTeam(workspace.id);
        },
      };
    });
    const personalOwner = ownerDestinationOptions.find(
      (option) => option.id === "default",
    );
    if (personalOwner) createOptions.push(personalOwner);
    const groupOwners = ownerDestinationOptions.filter(
      (option) => option.id !== "default",
    );
    if (groupOwners.length) {
      createOptions.push({
        id: "cloud-groups",
        testId: `collaboration-${kind}-create-cloud-groups`,
        label: messages.cloudGroups,
        description: messages.cloudGroupsHint,
        icon: <UsersRound aria-hidden="true" />,
        children: groupOwners,
      });
    }
  }
  useEffect(() => {
    setScope("all");
    setQuery("");
    setCreateOpen(false);
    setBindingResourceId(null);
    setBindingWorkspaceId(null);
    setDeletingAgent(null);
    setDeletingTeam(null);
    setDeleteError(null);
  }, [domain, kind]);
  const pageCopy = {
    agents: {
      title: messages.agents,
      hint: messages.agentsPageHint,
      search: messages.searchAgents,
      create: messages.createAgent,
      icon: Bot,
    },
    teams: {
      title: messages.teams,
      hint: messages.teamsPageHint,
      search: messages.searchTeams,
      create: messages.createTeam,
      icon: UsersRound,
    },
    devices: {
      title: messages.devices,
      hint: messages.devicesPageHint,
      search: messages.searchDevices,
      create: messages.addDevice,
      icon: Monitor,
    },
  }[kind];

  const agentRows = agents.map((agent) => {
    return {
      id: agent.id,
      name: agent.name,
      source: agent.location ?? ("cloud" as const),
      scope:
        agent.owner_type === "user" ? ("mine" as const) : ("shared" as const),
      owner: agent.owner_name,
      ownership: "",
      detail: "",
      access:
        agent.owner_type === "workspace"
          ? messages.currentWorkspace
          : messages.personalOwner,
      leader: "",
      participants: [] as CollaborationGroup["members"],
      leaderKind: "agent",
      tools: [] as string[],
      updatedAt: agent.status,
      status:
        agent.status === "unchecked"
          ? messages.selectable
          : agent.status === "available"
            ? messages.available
            : messages.unavailable,
      statusTone: agent.status,
      workspaceNames:
        agent.owner_type === "workspace"
          ? workspaces
              .filter((workspace) => workspace.id === agent.owner_id)
              .map((workspace) => workspace.name)
          : [],
    };
  });
  const teamRows = groups.map((group) => {
    const owningProject =
      group.owner_type === "project"
        ? projects.find((project) => project.id === group.owner_id)
        : null;
    const owningWorkspace =
      workspaces.find(
        (workspace) =>
          workspace.id === group.workspace_id ||
          (group.owner_type === "workspace" && workspace.id === group.owner_id),
      ) ??
      (owningProject?.workspace_id
        ? workspaces.find(
            (workspace) => workspace.id === owningProject.workspace_id,
          )
        : null);
    const participants = Array.from(
      new Map(
        [group.leader, ...group.members].map((member) => [
          `${member.kind}:${member.id}`,
          member,
        ]),
      ).values(),
    );
    return {
      id: group.id,
      name: group.name,
      source:
        owningWorkspace?.location ??
        workspaceLocations.get(group.workspace_id) ??
        ("cloud" as const),
      scope: "shared" as const,
      owner: owningProject?.name ?? owningWorkspace?.name ?? group.owner_id,
      ownership:
        group.owner_type === "project"
          ? messages.projectOwnership.replace(
              "{{name}}",
              owningProject?.name ?? group.owner_id,
            )
          : messages.workspaceOwnership.replace(
              "{{name}}",
              owningWorkspace?.name ?? group.owner_id,
            ),
      detail: `${participants.length} ${messages.memberCount}`,
      access: messages.currentWorkspace,
      leader: participantName(group.leader, group.workspace_id),
      leaderKind: group.leader.kind,
      participants,
      tools: [] as string[],
      updatedAt: group.updated_at,
      status: messages.available,
      statusTone: "available",
      workspaceNames: owningWorkspace ? [owningWorkspace.name] : [],
    };
  });
  const deviceRows = environments.map((environment) => ({
    id: environment.id,
    name: environment.name,
    source:
      environment.is_current_device === true
        ? ("local" as const)
        : ("cloud" as const),
    scope:
      environment.owner_type === "user"
        ? ("mine" as const)
        : ("shared" as const),
    owner: environment.owner_name,
    ownership: "",
    detail: `${environment.coding_tools.length} ${messages.toolCount}`,
    access:
      environment.owner_type === "workspace"
        ? messages.currentWorkspace
        : messages.personalOwner,
    leader: "",
    participants: [] as CollaborationGroup["members"],
    leaderKind: "agent",
    tools: environment.coding_tools,
    updatedAt: environment.updated_at,
    status:
      environment.status === "online"
        ? messages.online
        : environment.status === "provisioning"
          ? messages.provisioning
          : environment.status === "error"
            ? messages.errorStatus
            : messages.offline,
    statusTone: environment.status,
    workspaceNames:
      environment.owner_type === "workspace"
        ? workspaces
            .filter((workspace) => workspace.id === environment.owner_id)
            .map((workspace) => workspace.name)
        : [],
  }));
  const rows =
    kind === "agents" ? agentRows : kind === "teams" ? teamRows : deviceRows;
  const visibleRows = rows.filter(
    (row) =>
      (scope === "all" || row.scope === scope) &&
      (!normalizedQuery ||
        `${row.name} ${row.owner} ${row.workspaceNames.join(" ")}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );
  const PageIcon = pageCopy.icon;
  const rowsInSource = rows;
  const scopeCounts = {
    all: rowsInSource.length,
    mine: rowsInSource.filter((row) => row.scope === "mine").length,
    shared: rowsInSource.filter((row) => row.scope === "shared").length,
  };
  const bindingRow = rows.find((row) => row.id === bindingResourceId) ?? null;
  const formatCount = (template: string, count: number) =>
    template.replace("{{count}}", String(count));
  const workspaceUsage = (row: (typeof rows)[number]) =>
    row.source === "local"
      ? messages.localSpaces
      : row.workspaceNames.length
        ? formatCount(messages.addedToSpaceCount, row.workspaceNames.length)
        : messages.notAddedToSpace;
  const startCreate = () => {
    if (domain === "local") {
      if (kind === "agents") onCreateLocalAgent();
      if (kind === "teams" && localWorkspace) onCreateTeam(localWorkspace.id);
      return;
    }
    if (kind === "agents" && (!cloudAccess || cloudAccess.authenticated)) {
      onCreateAgent(resourceOwners);
      return;
    }
    setCreateOpen(true);
  };
  const canCreate =
    domain === "local"
      ? kind !== "devices" && Boolean(localWorkspace)
      : kind !== "devices" || canCreateDevice;

  return (
    <div
      className="collaboration-platform-page collaboration-resource-catalog-page"
      data-testid={`collaboration-${kind}-page`}
    >
      <header className="collaboration-resource-collection-header">
        <span className="collaboration-resource-collection-icon">
          <PageIcon aria-hidden="true" />
        </span>
        <span className="collaboration-resource-collection-copy">
          <span>
            <h1>{pageCopy.title}</h1>
            <em>
              {deviceCatalog && !deviceCatalog.complete && !rowsInSource.length
                ? "—"
                : rowsInSource.length}
            </em>
          </span>
          <p>{pageCopy.hint}</p>
        </span>
        {canCreate ? (
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid={`collaboration-${kind}-create`}
            onClick={startCreate}
          >
            <Plus aria-hidden="true" />
            {pageCopy.create}
          </button>
        ) : null}
      </header>

      <div className="collaboration-resource-catalog-toolbar">
        <div className="collaboration-resource-filter-stack">
          <div
            className="collaboration-resource-scope-filter"
            role="group"
            aria-label={messages.resourceSource}
          >
            {(["all", "mine", "shared"] as const).map((candidate) => (
              <button
                type="button"
                className={scope === candidate ? "active" : undefined}
                aria-pressed={scope === candidate}
                data-testid={`collaboration-${kind}-scope-${candidate}`}
                key={candidate}
                onClick={() => setScope(candidate)}
              >
                {candidate === "all"
                  ? messages.allSources
                  : candidate === "mine"
                    ? messages.createdByMe
                    : messages.teamShared}
                <em>
                  {deviceCatalog && !deviceCatalog.complete && !rows.length
                    ? "—"
                    : scopeCounts[candidate]}
                </em>
              </button>
            ))}
          </div>
        </div>
        <label className="collaboration-resource-catalog-search">
          <Search aria-hidden="true" />
          <input
            data-testid={`collaboration-${kind}-search`}
            placeholder={pageCopy.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {deviceCatalog ? (
        <DeviceCatalogFeedback catalog={deviceCatalog} translate={translate} />
      ) : null}
      <section className="collaboration-resource-catalog-list" data-kind={kind}>
        {visibleRows.length ? (
          <div className="collaboration-resource-catalog-list-header">
            <span>{pageCopy.title}</span>
            {kind === "agents" ? (
              <>
                <span>{messages.runStatus}</span>
                <span>{messages.usedBySpaces}</span>
              </>
            ) : kind === "teams" ? (
              <>
                <span>{messages.leader}</span>
                <span>{messages.memberCount}</span>
                <span>{messages.ownership}</span>
                <span>{messages.usedBySpaces}</span>
              </>
            ) : (
              <>
                <span>{messages.runStatus}</span>
                <span>{messages.toolCount}</span>
                <span>{messages.usedBySpaces}</span>
              </>
            )}
            <span aria-hidden="true" />
          </div>
        ) : null}
        {visibleRows.length ? (
          visibleRows.map((row) => (
            <article
              data-source={row.source}
              data-testid={`collaboration-${kind}-row-${row.id}`}
              key={row.id}
            >
              <span className="collaboration-resource-row-icon">
                {kind === "agents" ? (
                  <Bot aria-hidden="true" />
                ) : kind === "teams" ? (
                  <UsersRound aria-hidden="true" />
                ) : (
                  <Monitor aria-hidden="true" />
                )}
              </span>
              <span className="collaboration-resource-row-copy">
                <strong>{row.name}</strong>
                {row.detail ? <small>{row.detail}</small> : null}
              </span>
              {kind === "agents" ? (
                <>
                  <span
                    className="collaboration-resource-row-status"
                    data-tone={row.statusTone}
                    title={
                      row.statusTone === "unchecked"
                        ? messages.agentUncheckedHint
                        : row.statusTone === "available"
                          ? messages.agentAvailableHint
                          : messages.agentUnavailableHint
                    }
                  >
                    {row.status}
                  </span>
                  <span className="collaboration-resource-row-detail">
                    {workspaceUsage(row)}
                  </span>
                </>
              ) : kind === "teams" ? (
                <>
                  <span className="collaboration-resource-row-leader">
                    {row.leaderKind === "human" ? (
                      <UserRound aria-hidden="true" />
                    ) : (
                      <Bot aria-hidden="true" />
                    )}
                    <span title={row.leader}>{row.leader}</span>
                  </span>
                  <span className="collaboration-resource-row-members">
                    {row.participants.slice(0, 3).map((member) => {
                      const label = participantName(
                        member,
                        groups.find((group) => group.id === row.id)!
                          .workspace_id,
                      );
                      return (
                        <span
                          key={`${member.kind}:${member.id}`}
                          title={label}
                          aria-label={label}
                        >
                          {member.kind === "human" ? (
                            <UserRound aria-hidden="true" />
                          ) : (
                            <Bot aria-hidden="true" />
                          )}
                        </span>
                      );
                    })}
                    {row.participants.length > 3 ? (
                      <em>+{row.participants.length - 3}</em>
                    ) : null}
                  </span>
                  <span
                    className="collaboration-resource-row-ownership"
                    data-testid={`collaboration-team-owner-${row.id}`}
                    title={row.ownership}
                  >
                    {row.ownership}
                  </span>
                  <span className="collaboration-resource-row-detail">
                    {workspaceUsage(row)}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="collaboration-resource-row-status"
                    data-tone={row.statusTone}
                  >
                    {row.status}
                  </span>
                  <span className="collaboration-resource-row-tools">
                    {row.tools.slice(0, 3).map((tool) => (
                      <em key={tool}>{runtimeLabel(tool)}</em>
                    ))}
                    {row.tools.length > 3 ? (
                      <em>+{row.tools.length - 3}</em>
                    ) : null}
                  </span>
                  <span className="collaboration-resource-row-detail">
                    {workspaceUsage(row)}
                  </span>
                </>
              )}
              <span className="collaboration-resource-row-actions">
                {kind !== "teams" && row.source === "cloud" ? (
                  <button
                    type="button"
                    className="collaboration-resource-bind-button"
                    data-testid={`collaboration-${kind}-bind-${row.id}`}
                    onClick={() => {
                      setBindingResourceId(row.id);
                    }}
                  >
                    {messages.addToSpace}
                  </button>
                ) : null}
                {
                  <button
                    type="button"
                    className="collaboration-resource-settings-button"
                    aria-label={messages.resourceSettings}
                    title={messages.resourceSettings}
                    data-testid={`collaboration-${kind}-settings-${row.id}`}
                    onClick={() => onManageResource(kind, row.id, row.source)}
                  >
                    <Settings aria-hidden="true" />
                  </button>
                }
                {kind === "agents" &&
                agents.find((agent) => agent.id === row.id)?.deletable !==
                  false ? (
                  <button
                    type="button"
                    className="collaboration-resource-settings-button"
                    aria-label={messages.deleteAgent}
                    title={messages.deleteAgent}
                    data-testid={`collaboration-agents-delete-${row.id}`}
                    onClick={() => {
                      setDeleteError(null);
                      setDeletingAgent(
                        agents.find((agent) => agent.id === row.id) ?? null,
                      );
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                ) : kind === "teams" ? (
                  <button
                    type="button"
                    className="collaboration-resource-settings-button collaboration-resource-delete-button"
                    aria-label={messages.deleteTeam}
                    title={messages.deleteTeam}
                    data-testid={`collaboration-teams-delete-${row.id}`}
                    onClick={() => {
                      setDeleteError(null);
                      setDeletingTeam(
                        groups.find((group) => group.id === row.id) ?? null,
                      );
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </article>
          ))
        ) : deviceCatalog && !deviceCatalog.complete ? null : (
          <div className="collaboration-resource-catalog-empty">
            <PageIcon aria-hidden="true" />
            <strong>
              {kind === "devices"
                ? translate("todo.device_catalog_empty", "尚未添加设备")
                : domain === "local"
                  ? kind === "agents"
                    ? messages.noLocalAgents
                    : messages.noLocalTeams
                  : kind === "agents"
                    ? messages.noCloudAgents
                    : messages.noCloudTeams}
            </strong>
            <p>{pageCopy.hint}</p>
          </div>
        )}
      </section>
      {createOpen ? (
        <ResourceDestinationDialog
          title={messages.chooseResourceOwner}
          description={messages.chooseResourceOwnerHint}
          closeLabel={messages.cancel}
          options={createOptions}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {bindingRow ? (
        <div
          className="collaboration-resource-dialog-backdrop"
          role="presentation"
          onMouseDown={() => setBindingResourceId(null)}
        >
          <section
            className="collaboration-resource-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={messages.chooseSpace}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>{messages.chooseSpace}</h2>
                <p>{messages.chooseSpaceHint}</p>
              </div>
              <button
                type="button"
                aria-label={messages.cancel}
                onClick={() => setBindingResourceId(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="collaboration-resource-space-options">
              {cloudWorkspaces.length ? (
                cloudWorkspaces.map((workspace) => (
                  <button
                    type="button"
                    key={workspace.id}
                    data-testid={`collaboration-${kind}-space-${workspace.id}`}
                    disabled={bindingWorkspaceId === workspace.id}
                    onClick={() => {
                      setBindingWorkspaceId(workspace.id);
                      void onAddToWorkspace(workspace.id, kind, bindingRow.id)
                        .then(() => setBindingResourceId(null))
                        .finally(() => setBindingWorkspaceId(null));
                    }}
                  >
                    <FolderOpen aria-hidden="true" />
                    <span>
                      <strong>{workspace.name}</strong>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                ))
              ) : (
                <p>{messages.noAvailableSpaces}</p>
              )}
            </div>
          </section>
        </div>
      ) : null}
      {deletingAgent ? (
        <div
          className="collaboration-resource-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleteBusy) {
              setDeletingAgent(null);
              setDeleteError(null);
            }
          }}
        >
          <section
            className="collaboration-resource-dialog collaboration-delete-agent-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="collaboration-delete-agent-title"
            data-testid="collaboration-delete-agent-dialog"
          >
            <header>
              <div>
                <h2 id="collaboration-delete-agent-title">
                  {messages.deleteAgent}
                </h2>
                <p>
                  <strong>{deletingAgent.name}</strong>
                  <br />
                  {messages.deleteAgentConfirm}
                </p>
              </div>
              <button
                type="button"
                className="collaboration-resource-dialog-close"
                aria-label={messages.cancel}
                disabled={deleteBusy}
                onClick={() => setDeletingAgent(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            {deleteError ? (
              <p className="collaboration-resource-form-error">{deleteError}</p>
            ) : null}
            <div className="collaboration-resource-form-actions collaboration-delete-agent-actions">
              <button
                type="button"
                className="collaboration-secondary-button"
                disabled={deleteBusy}
                onClick={() => setDeletingAgent(null)}
              >
                {messages.cancel}
              </button>
              <button
                type="button"
                className="collaboration-primary-button"
                data-testid="collaboration-delete-agent-confirm"
                disabled={deleteBusy}
                onClick={() => {
                  setDeleteBusy(true);
                  setDeleteError(null);
                  void onDeleteAgent(deletingAgent)
                    .then(() => setDeletingAgent(null))
                    .catch(() => setDeleteError(messages.deleteFailed))
                    .finally(() => setDeleteBusy(false));
                }}
              >
                {deleteBusy ? messages.deleting : messages.deleteAgent}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {deletingTeam ? (
        <div
          className="collaboration-resource-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleteBusy) {
              setDeletingTeam(null);
              setDeleteError(null);
            }
          }}
        >
          <section
            className="collaboration-resource-dialog collaboration-delete-agent-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="collaboration-delete-team-title"
            data-testid="collaboration-delete-team-dialog"
          >
            <header>
              <div>
                <h2 id="collaboration-delete-team-title">
                  {messages.deleteTeam}
                </h2>
                <p>
                  <strong>{deletingTeam.name}</strong>
                  <br />
                  {messages.deleteTeamConfirm}
                </p>
              </div>
              <button
                type="button"
                className="collaboration-resource-dialog-close"
                aria-label={messages.cancel}
                disabled={deleteBusy}
                onClick={() => setDeletingTeam(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            {deleteError ? (
              <p className="collaboration-resource-form-error">{deleteError}</p>
            ) : null}
            <div className="collaboration-resource-form-actions collaboration-delete-agent-actions">
              <button
                type="button"
                className="collaboration-secondary-button"
                disabled={deleteBusy}
                onClick={() => setDeletingTeam(null)}
              >
                {messages.cancel}
              </button>
              <button
                type="button"
                className="collaboration-primary-button"
                data-testid="collaboration-delete-team-confirm"
                disabled={deleteBusy}
                onClick={() => {
                  setDeleteBusy(true);
                  setDeleteError(null);
                  void onDeleteTeam(deletingTeam)
                    .then(() => setDeletingTeam(null))
                    .catch(() => setDeleteError(messages.deleteFailed))
                    .finally(() => setDeleteBusy(false));
                }}
              >
                {deleteBusy ? messages.deleting : messages.deleteTeam}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
