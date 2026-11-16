// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ProjectCreateFormView } from "./ProjectCreateFormView";
import { ProjectCreateGroupView } from "./ProjectCreateGroupView";
import { DefaultModal } from "./ProjectCreatePrimitives";

import type { UnifiedModel } from "@wegent/chat-core/models";
import { GitBranch, Grid3X3, ListTodo } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ProjectCreateDiscardView } from "./ProjectCreateDiscardView";

import { type ComposerInputHandle } from "../composer";
import { createCollaborationTranslator } from "../i18n";
import type { CollaborationWorkspaceMember } from "../types";
import { changeCollaborationGroupLeader } from "./collaborationGroupDraft";
import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateCollaborationGroupGenerationEvent,
  ProjectCreateDialogProps,
  ProjectCreateGenerationProgressPhase,
} from "./types";
import { useProjectCreateController } from "./useProjectCreateController";
import {
  generationModelKey,
  useProjectGenerationModels,
} from "./useProjectGenerationModels";

/** Show template resource loading and recovery alongside the controller's submission boundary. */
export function ProjectCreateDialog(props: ProjectCreateDialogProps) {
  const {
    targets,
    allowDingTalkAITable,
    labels,
    resourceSetup,
    testIds,
    host,
    onClose,
    workspaceContext,
  } = props;
  const { state, commands } = useProjectCreateController(props);
  const nameInput = useRef<HTMLInputElement>(null);
  const repositoryInput = useRef<HTMLInputElement>(null);
  const nameLabelId = useId();
  const nameErrorId = useId();
  const [discardTarget, setDiscardTarget] = useState<
    "project" | "group" | null
  >(null);
  useEffect(() => {
    if (state.submitErrorField === "name") nameInput.current?.focus();
  }, [state.submitErrorField]);
  const translate = createCollaborationTranslator(labels.locale);
  const generationComposerRef = useRef<ComposerInputHandle>(null);
  const [collaboratorPickerOpen, setCollaboratorPickerOpen] = useState(false);
  const [addedPeople, setAddedPeople] = useState<
    CollaborationWorkspaceMember[]
  >([]);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  useEffect(() => {
    if (state.submitErrorField === "repository") setAdvancedSettingsOpen(true);
  }, [state.submitErrorField]);
  useEffect(() => {
    if (state.submitErrorField === "repository" && advancedSettingsOpen)
      repositoryInput.current?.focus();
  }, [state.submitErrorField, advancedSettingsOpen]);
  const [groupRecommendationDismissed, setGroupRecommendationDismissed] =
    useState(false);
  const [groupEditorDraft, setGroupEditorDraft] =
    useState<ProjectCreateCollaborationGroupDraft | null>(null);
  const [groupModelPickerOpen, setGroupModelPickerOpen] = useState(false);
  const [configurationTarget, setConfigurationTarget] =
    useState<HTMLElement | null>(null);
  const [templateConfiguration, setTemplateConfiguration] = useState<{
    title: string;
    onBack: () => void;
  } | null>(null);
  const initialGenerationInstructions = useRef(labels.generationRequestDefault);
  const [groupGenerationInstructions, setGroupGenerationInstructions] =
    useState(labels.generationRequestDefault);
  const [groupGenerating, setGroupGenerating] = useState(false);
  const [groupGenerationPhase, setGroupGenerationPhase] =
    useState<ProjectCreateGenerationProgressPhase | null>(null);
  const [groupGenerationPrinciples, setGroupGenerationPrinciples] = useState<
    string[]
  >([]);
  const [groupGenerationLeader, setGroupGenerationLeader] = useState<{
    kind: "human" | "agent";
    id: string;
  } | null>(null);
  const [groupGenerationElapsedSeconds, setGroupGenerationElapsedSeconds] =
    useState(0);
  const [revealedGenerationAgentIds, setRevealedGenerationAgentIds] = useState<
    string[]
  >([]);
  const [groupGenerationResponsibilities, setGroupGenerationResponsibilities] =
    useState<Record<string, string>>({});
  const [groupGenerationStages, setGroupGenerationStages] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const groupGenerationQueuedAgentIdsRef = useRef(new Set<string>());
  const groupGenerationRevealedAgentIdsRef = useRef(new Set<string>());
  const groupGenerationAgentQueueRef = useRef<string[]>([]);
  const groupGenerationAgentTimerRef = useRef<number | null>(null);
  const groupGenerationAgentSettlingRef = useRef(false);
  const groupGenerationStartedAtRef = useRef(0);
  const groupGenerationRunRef = useRef(0);
  const [groupGenerationError, setGroupGenerationError] = useState<
    string | null
  >(null);
  const {
    models: generationModels,
    key: selectedGenerationModelKey,
    options: selectedGenerationModelOptions,
    loading: generationModelsLoading,
    error: generationModelsError,
    reload: reloadGenerationModels,
    selectModel: selectGenerationModel,
    setOptions: setSelectedGenerationModelOptions,
  } = useProjectGenerationModels(
    groupModelPickerOpen,
    resourceSetup?.loadCollaborationGroupGenerationModels,
    host?.formatError,
    labels.createFailed,
  );
  useEffect(() => {
    if (!groupGenerating) return;
    const startedAt = Date.now();
    setGroupGenerationElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setGroupGenerationElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [groupGenerating]);
  useEffect(
    () => () => {
      groupGenerationRunRef.current += 1;
      if (groupGenerationAgentTimerRef.current !== null) {
        window.clearTimeout(groupGenerationAgentTimerRef.current);
      }
      groupGenerationAgentSettlingRef.current = false;
    },
    [],
  );
  const collaboratorsLocked = state.saving || Boolean(state.createdProject);
  const people = [...(resourceSetup?.members ?? []), ...addedPeople].filter(
    (member, index, all) =>
      all.findIndex((candidate) => candidate.user_id === member.user_id) ===
      index,
  );
  const selectedMembers = people.filter(
    (member) =>
      member.user_id !== resourceSetup?.currentUser.id &&
      state.memberUserIds.includes(member.user_id),
  );
  const selectedGenerationHumans = resourceSetup
    ? [
        {
          id: String(resourceSetup.currentUser.id),
          name: labels.currentUser,
        },
        ...selectedMembers.map((member) => ({
          id: String(member.user_id),
          name: member.user_name,
        })),
      ]
    : [];
  const selectedAgents =
    resourceSetup?.agents.filter((agent) =>
      state.agentResourceIds.includes(agent.id),
    ) ?? [];
  const availableAgents =
    resourceSetup?.agents.filter(
      (agent) => !state.agentResourceIds.includes(agent.id),
    ) ?? [];
  const participantName = (kind: "human" | "agent", id: string) => {
    if (kind === "human") {
      if (id === String(resourceSetup?.currentUser.id)) {
        return labels.currentUser;
      }
      return (
        people.find((member) => String(member.user_id) === id)?.user_name ?? id
      );
    }
    return resourceSetup?.agents.find((agent) => agent.id === id)?.name ?? id;
  };
  const removeMember = (userId: number) => {
    if (collaboratorsLocked) return;
    commands.setMemberUserIds(
      state.memberUserIds.filter((candidate) => candidate !== userId),
    );
  };
  const removeAgent = (resourceId: string) => {
    if (collaboratorsLocked) return;
    commands.setAgentResourceIds(
      state.agentResourceIds.filter((candidate) => candidate !== resourceId),
    );
  };
  const addAgent = (resourceId: string) => {
    if (collaboratorsLocked) return;
    commands.setAgentResourceIds([...state.agentResourceIds, resourceId]);
    setGroupRecommendationDismissed(false);
    setCollaboratorPickerOpen(false);
  };
  const importGroup = (groupId: string) => {
    if (collaboratorsLocked) return;
    const group = resourceSetup?.groups.find(
      (candidate) => candidate.id === groupId,
    );
    if (!group || !resourceSetup) return;
    const groupParticipants = [group.leader, ...group.members].filter(
      (participant, index, participants) =>
        participants.findIndex(
          (candidate) =>
            candidate.kind === participant.kind &&
            candidate.id === participant.id,
        ) === index,
    );
    const humanIds = groupParticipants
      .filter((member) => member.kind === "human")
      .map((member) => Number(member.id))
      .filter(
        (userId) =>
          Number.isFinite(userId) && userId !== resourceSetup.currentUser.id,
      );
    const agentIds = groupParticipants
      .filter((member) => member.kind === "agent")
      .map((member) => member.id)
      .filter((id) => resourceSetup.agents.some((agent) => agent.id === id));
    commands.setMemberUserIds([
      ...new Set([...state.memberUserIds, ...humanIds]),
    ]);
    commands.setAgentResourceIds([
      ...new Set([...state.agentResourceIds, ...agentIds]),
    ]);
    commands.setCollaborationGroupDraft({
      name: group.name,
      description: group.description,
      instructions: group.instructions ?? "",
      leader: group.leader,
      members: group.members,
      stages: group.stages,
      executionRequirements: {
        requiredTags: group.execution_requirements?.required_tags ?? [],
      },
    });
    setCollaboratorPickerOpen(false);
  };
  const selectedGenerationModel =
    generationModels.find(
      (model) => generationModelKey(model) === selectedGenerationModelKey,
    ) ?? null;
  const unifiedGenerationModels: UnifiedModel[] = generationModels.map(
    (model) => ({
      name: model.modelName,
      type: model.modelType ?? "runtime",
      displayName: model.displayName,
    }),
  );
  const selectedUnifiedGenerationModel =
    unifiedGenerationModels.find(
      (model) =>
        generationModelKey({
          modelName: model.name,
          modelType: model.type,
        }) === selectedGenerationModelKey,
    ) ?? null;
  const revealNextGenerationAgent = (): void => {
    if (groupGenerationAgentTimerRef.current !== null) return;
    const agentId = groupGenerationAgentQueueRef.current.shift();
    if (!agentId) return;
    const delay =
      groupGenerationRevealedAgentIdsRef.current.size === 0 ? 80 : 420;
    groupGenerationAgentSettlingRef.current = false;
    groupGenerationAgentTimerRef.current = window.setTimeout(() => {
      groupGenerationAgentTimerRef.current = null;
      groupGenerationQueuedAgentIdsRef.current.delete(agentId);
      groupGenerationRevealedAgentIdsRef.current.add(agentId);
      setRevealedGenerationAgentIds((current) =>
        current.includes(agentId) ? current : [...current, agentId],
      );
      console.debug("[CollaborationGroupGeneration]", {
        event: "agent-revealed",
        agentId,
        elapsedMs: Math.round(
          performance.now() - groupGenerationStartedAtRef.current,
        ),
        remainingAgents: groupGenerationAgentQueueRef.current.length,
      });
      if (groupGenerationAgentQueueRef.current.length > 0) {
        revealNextGenerationAgent();
        return;
      }
      groupGenerationAgentSettlingRef.current = true;
      groupGenerationAgentTimerRef.current = window.setTimeout(() => {
        groupGenerationAgentTimerRef.current = null;
        groupGenerationAgentSettlingRef.current = false;
        if (groupGenerationAgentQueueRef.current.length > 0) {
          revealNextGenerationAgent();
          return;
        }
        console.debug("[CollaborationGroupGeneration]", {
          event: "formation-settled",
          elapsedMs: Math.round(
            performance.now() - groupGenerationStartedAtRef.current,
          ),
        });
      }, 400);
    }, delay);
  };
  const enqueueGenerationAgent = (
    agentId: string,
    responsibility?: string | null,
  ) => {
    if (responsibility) {
      setGroupGenerationResponsibilities((current) =>
        current[agentId] === responsibility
          ? current
          : { ...current, [agentId]: responsibility },
      );
    }
    if (
      groupGenerationQueuedAgentIdsRef.current.has(agentId) ||
      groupGenerationRevealedAgentIdsRef.current.has(agentId)
    ) {
      return;
    }
    groupGenerationQueuedAgentIdsRef.current.add(agentId);
    groupGenerationAgentQueueRef.current.push(agentId);
    if (
      groupGenerationAgentSettlingRef.current &&
      groupGenerationAgentTimerRef.current !== null
    ) {
      window.clearTimeout(groupGenerationAgentTimerRef.current);
      groupGenerationAgentTimerRef.current = null;
      groupGenerationAgentSettlingRef.current = false;
    }
    console.debug("[CollaborationGroupGeneration]", {
      event: "agent-detected",
      agentId,
      elapsedMs: Math.round(
        performance.now() - groupGenerationStartedAtRef.current,
      ),
      queuedAgents: groupGenerationAgentQueueRef.current.length,
    });
    revealNextGenerationAgent();
  };
  const handleGroupGenerationEvent = (
    event: ProjectCreateCollaborationGroupGenerationEvent,
  ) => {
    console.debug("[CollaborationGroupGeneration]", {
      event: "structured-event",
      type: event.type,
      elapsedMs: Math.round(
        performance.now() - groupGenerationStartedAtRef.current,
      ),
    });
    if (event.type === "participant_started") {
      if (event.leader) {
        setGroupGenerationLeader({ kind: event.kind, id: event.id });
      }
      return;
    }
    if (event.type === "participant_delta") {
      const responsibilityKey =
        event.kind === "human" ? `human:${event.id}` : event.id;
      setGroupGenerationResponsibilities((current) => ({
        ...current,
        [responsibilityKey]: `${current[responsibilityKey] ?? ""}${event.delta}`,
      }));
      if (event.kind === "agent") enqueueGenerationAgent(event.id);
      return;
    }
    if (event.type === "principle") {
      setGroupGenerationPrinciples((current) => [...current, event.text]);
      return;
    }
    if (event.type === "stage") {
      setGroupGenerationStages((current) => {
        const existingIndex = current.findIndex(
          (stage) => stage.id === event.id,
        );
        if (existingIndex < 0) {
          return [...current, { id: event.id, name: event.name }];
        }
        return current.map((stage, index) =>
          index === existingIndex ? { id: event.id, name: event.name } : stage,
        );
      });
    }
  };
  const openGeneratedGroupDraft = async (
    instructions = groupGenerationInstructions,
  ) => {
    if (!resourceSetup) return;
    if (!resourceSetup.generateCollaborationGroupDraft) {
      setGroupGenerationError(labels.groupGenerationUnavailable);
      return;
    }
    if (!selectedGenerationModel) {
      setGroupGenerationError(labels.generationModelRequired);
      return;
    }
    const runId = ++groupGenerationRunRef.current;
    setCollaboratorPickerOpen(false);
    setGroupGenerating(true);
    setGroupGenerationPhase("preparing");
    setGroupGenerationPrinciples([]);
    setGroupGenerationStages([]);
    setGroupGenerationLeader(null);
    setRevealedGenerationAgentIds([]);
    setGroupGenerationResponsibilities({});
    groupGenerationQueuedAgentIdsRef.current.clear();
    groupGenerationRevealedAgentIdsRef.current.clear();
    groupGenerationAgentQueueRef.current = [];
    if (groupGenerationAgentTimerRef.current !== null) {
      window.clearTimeout(groupGenerationAgentTimerRef.current);
      groupGenerationAgentTimerRef.current = null;
    }
    groupGenerationAgentSettlingRef.current = false;
    groupGenerationStartedAtRef.current = performance.now();
    console.debug("[CollaborationGroupGeneration]", {
      event: "generation-started",
      agentCount: selectedAgents.length,
      modelName: selectedGenerationModel.modelName,
    });
    setGroupGenerationError(null);
    try {
      const draft = await resourceSetup.generateCollaborationGroupDraft(
        {
          projectName: state.name.trim(),
          projectDescription: state.description.trim(),
          generationInstructions: instructions.trim(),
          currentUser: resourceSetup.currentUser,
          members: selectedMembers,
          agents: selectedAgents,
          modelSelection: {
            modelName: selectedGenerationModel.modelName,
            modelType: selectedGenerationModel.modelType,
            options: selectedGenerationModelOptions,
          },
        },
        (phase) => {
          if (groupGenerationRunRef.current !== runId) return;
          console.debug("[CollaborationGroupGeneration]", {
            event: "phase-changed",
            phase,
            elapsedMs: Math.round(
              performance.now() - groupGenerationStartedAtRef.current,
            ),
          });
          setGroupGenerationPhase(phase);
        },
        (event) => {
          if (groupGenerationRunRef.current === runId) {
            handleGroupGenerationEvent(event);
          }
        },
      );
      if (groupGenerationRunRef.current !== runId) return;
      const draftParticipants = [draft.leader, ...draft.members];
      setGroupGenerationLeader({
        kind: draft.leader.kind,
        id: draft.leader.id,
      });
      setGroupGenerationResponsibilities(
        Object.fromEntries(
          draftParticipants.map((participant) => [
            participant.kind === "human"
              ? `human:${participant.id}`
              : participant.id,
            participant.responsibility,
          ]),
        ),
      );
      setGroupGenerationStages(
        draft.stages.map((stage) => ({ id: stage.id, name: stage.name })),
      );
      selectedAgents.forEach((agent) => {
        const participant = draftParticipants.find(
          (candidate) =>
            candidate.kind === "agent" && candidate.id === agent.id,
        );
        enqueueGenerationAgent(agent.id, participant?.responsibility);
      });
      const selectedAgentIds = selectedAgents.map((agent) => agent.id);
      while (
        groupGenerationRunRef.current === runId &&
        selectedAgentIds.some(
          (agentId) => !groupGenerationRevealedAgentIdsRef.current.has(agentId),
        )
      ) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
      if (groupGenerationRunRef.current !== runId) return;
      if (groupGenerationAgentTimerRef.current !== null) {
        window.clearTimeout(groupGenerationAgentTimerRef.current);
        groupGenerationAgentTimerRef.current = null;
      }
      groupGenerationAgentQueueRef.current = [];
      groupGenerationQueuedAgentIdsRef.current.clear();
      groupGenerationAgentSettlingRef.current = false;
      setGroupEditorDraft(draft);
    } catch (cause) {
      if (groupGenerationRunRef.current !== runId) return;
      setGroupGenerationError(
        host?.formatError?.(cause) ??
          (cause instanceof Error && cause.message
            ? cause.message
            : labels.createFailed),
      );
    } finally {
      if (groupGenerationRunRef.current === runId) {
        setGroupGenerating(false);
        setGroupGenerationPhase(null);
      }
    }
  };
  const openGroupModelPicker = () => {
    setCollaboratorPickerOpen(false);
    setGroupGenerationError(null);
    setGroupModelPickerOpen(true);
  };
  const updateGroupParticipant = (
    participant: { kind: "human" | "agent"; id: string },
    responsibility: string,
  ) => {
    setGroupEditorDraft((current) => {
      if (!current) return current;
      const update = (candidate: {
        kind: "human" | "agent";
        id: string;
        responsibility: string;
      }) =>
        candidate.kind === participant.kind && candidate.id === participant.id
          ? { ...candidate, responsibility }
          : candidate;
      return {
        ...current,
        leader: update(current.leader),
        members: current.members.map(update),
      };
    });
  };
  const setGroupLeader = (participant: {
    kind: "human" | "agent";
    id: string;
  }) => {
    setGroupEditorDraft((current) => {
      if (!current) return current;
      return changeCollaborationGroupLeader(current, participant);
    });
  };
  const groupedParticipants = state.collaborationGroupDraft
    ? [
        state.collaborationGroupDraft.leader,
        ...state.collaborationGroupDraft.members,
      ].filter(
        (participant, index, participants) =>
          participants.findIndex(
            (candidate) =>
              candidate.kind === participant.kind &&
              candidate.id === participant.id,
          ) === index,
      )
    : [];
  const inGroup = (kind: "human" | "agent", id: string) =>
    groupedParticipants.some(
      (participant) => participant.kind === kind && participant.id === id,
    );
  const directMembers = selectedMembers.filter(
    (member) => !inGroup("human", String(member.user_id)),
  );
  const directAgents = selectedAgents.filter(
    (agent) => !inGroup("agent", agent.id),
  );
  const assignedAgentIds = new Set(revealedGenerationAgentIds);
  const draftParticipants = groupEditorDraft
    ? [groupEditorDraft.leader, ...groupEditorDraft.members]
    : [];
  const visibleGroupParticipants = [
    ...selectedGenerationHumans.map((member) => {
      const draftParticipant = draftParticipants.find(
        (candidate) => candidate.kind === "human" && candidate.id === member.id,
      );
      return {
        kind: "human" as const,
        id: member.id,
        name: member.name,
        responsibility:
          draftParticipant?.responsibility ??
          groupGenerationResponsibilities[`human:${member.id}`],
        leader: groupEditorDraft
          ? draftParticipant?.kind === groupEditorDraft.leader.kind &&
            draftParticipant?.id === groupEditorDraft.leader.id
          : groupGenerationLeader?.kind === "human" &&
            groupGenerationLeader.id === member.id,
        className: "is-human-standing",
        draftParticipant,
      };
    }),
    ...selectedAgents
      .filter((agent) => assignedAgentIds.has(agent.id))
      .map((agent) => {
        const draftParticipant = draftParticipants.find(
          (candidate) =>
            candidate.kind === "agent" && candidate.id === agent.id,
        );
        return {
          kind: "agent" as const,
          id: agent.id,
          name: agent.name,
          responsibility:
            draftParticipant?.responsibility ??
            groupGenerationResponsibilities[agent.id],
          leader: groupEditorDraft
            ? draftParticipant?.kind === groupEditorDraft.leader.kind &&
              draftParticipant?.id === groupEditorDraft.leader.id
            : groupGenerationLeader?.kind === "agent" &&
              groupGenerationLeader.id === agent.id,
          className: `is-assigned${groupEditorDraft ? "" : " is-excited"}`,
          draftParticipant,
        };
      }),
  ];
  const generationPhaseLabel =
    groupGenerationPhase === "preparing"
      ? labels.preparingGenerationModel
      : labels.generatingResponsibilities;
  const renderModal =
    host?.renderModal ?? ((modalProps) => <DefaultModal {...modalProps} />);
  const cloudLocationDescription = workspaceContext
    ? `${workspaceContext.name} · ${workspaceContext.owner}`
    : labels.cloudLocationDescription;
  const providers = [
    {
      id: "local" as const,
      icon: <ListTodo aria-hidden="true" />,
      label: labels.builtInProvider,
      description:
        state.location === "local"
          ? labels.builtInLocalDescription
          : labels.builtInCloudDescription,
    },
    {
      id: "github" as const,
      icon: <GitBranch aria-hidden="true" />,
      label: "GitHub",
      description: labels.githubDescription,
    },
    {
      id: "gitlab" as const,
      icon: <GitBranch aria-hidden="true" />,
      label: "GitLab",
      description: labels.gitlabDescription,
    },
    ...(allowDingTalkAITable && host?.parseDingTalkAITableLink
      ? [
          {
            id: "dingtalk_aitable" as const,
            icon: <Grid3X3 aria-hidden="true" />,
            label: labels.aitableProvider,
            description: labels.aitableDescription,
          },
        ]
      : []),
  ];
  const providerSummary =
    state.taskProvider === "local"
      ? labels.advancedSettingsSummary
      : [
          labels.advancedSettingsSummary,
          providers.find((provider) => provider.id === state.taskProvider)
            ?.label,
          state.repositoryError ??
            (state.repositoryProvider && !state.repositoryAddress.trim()
              ? labels.repositoryRequired
              : state.isAITableProvider && !state.aitableLink
                ? labels.aitableInvalid
                : null),
        ]
          .filter(Boolean)
          .join(" · ");

  const closeGroupConfiguration = () => {
    groupGenerationRunRef.current += 1;
    if (groupGenerationAgentTimerRef.current !== null) {
      window.clearTimeout(groupGenerationAgentTimerRef.current);
      groupGenerationAgentTimerRef.current = null;
    }
    groupGenerationAgentQueueRef.current = [];
    groupGenerationQueuedAgentIdsRef.current.clear();
    groupGenerationAgentSettlingRef.current = false;
    setGroupModelPickerOpen(false);
    setGroupEditorDraft(null);
    setGroupGenerating(false);
    setGroupGenerationPhase(null);
  };
  const requestGroupClose = () => {
    const hasUnsavedGroupDraft =
      groupEditorDraft !== null &&
      JSON.stringify(groupEditorDraft) !==
        JSON.stringify(state.collaborationGroupDraft);
    if (hasUnsavedGroupDraft || groupGenerating) setDiscardTarget("group");
    else closeGroupConfiguration();
  };
  const requestProjectClose = () => {
    if (state.saving) return;
    if (
      state.hasDraft ||
      groupEditorDraft ||
      groupGenerationInstructions !== initialGenerationInstructions.current
    )
      setDiscardTarget("project");
    else onClose();
  };
  const groupConfiguration = groupModelPickerOpen ? (
    <ProjectCreateGroupView
      requestGroupClose={requestGroupClose}
      discardTarget={discardTarget}
      labels={labels}
      groupEditorDraft={groupEditorDraft}
      commands={commands}
      setGroupEditorDraft={setGroupEditorDraft}
      setGroupModelPickerOpen={setGroupModelPickerOpen}
      setGroupRecommendationDismissed={setGroupRecommendationDismissed}
      generationModelsLoading={generationModelsLoading}
      generationModelsError={generationModelsError}
      reloadGenerationModels={reloadGenerationModels}
      groupGenerationError={groupGenerationError}
      groupGenerating={groupGenerating}
      generationComposerRef={generationComposerRef}
      translate={translate}
      groupGenerationInstructions={groupGenerationInstructions}
      setGroupGenerationInstructions={setGroupGenerationInstructions}
      openGeneratedGroupDraft={openGeneratedGroupDraft}
      generationModels={generationModels}
      selectedAgents={selectedAgents}
      selectedGenerationHumans={selectedGenerationHumans}
      resourceSetup={resourceSetup}
      unifiedGenerationModels={unifiedGenerationModels}
      selectedUnifiedGenerationModel={selectedUnifiedGenerationModel}
      selectedGenerationModelOptions={selectedGenerationModelOptions}
      selectGenerationModel={selectGenerationModel}
      setGroupGenerationError={setGroupGenerationError}
      setSelectedGenerationModelOptions={setSelectedGenerationModelOptions}
      generationPhaseLabel={generationPhaseLabel}
      groupGenerationElapsedSeconds={groupGenerationElapsedSeconds}
      assignedAgentIds={assignedAgentIds}
      visibleGroupParticipants={visibleGroupParticipants}
      setGroupLeader={setGroupLeader}
      updateGroupParticipant={updateGroupParticipant}
      groupGenerationPrinciples={groupGenerationPrinciples}
      groupGenerationStages={groupGenerationStages}
    />
  ) : null;

  return renderModal({
    title: discardTarget
      ? discardTarget === "project"
        ? labels.discardProjectTitle
        : labels.discardGroupTitle
      : groupModelPickerOpen
        ? groupEditorDraft
          ? labels.groupDraftTitle
          : labels.selectGenerationModel
        : (templateConfiguration?.title ?? labels.title),
    closeLabel: labels.close,
    onClose: () => {
      if (discardTarget) setDiscardTarget(null);
      else if (groupModelPickerOpen) requestGroupClose();
      else if (templateConfiguration) templateConfiguration.onBack();
      else requestProjectClose();
    },
    children: (
      <>
        <ProjectCreateFormView
          groupModelPickerOpen={groupModelPickerOpen}
          templateConfiguration={templateConfiguration}
          discardTarget={discardTarget}
          commands={commands}
          nameLabelId={nameLabelId}
          labels={labels}
          nameInput={nameInput}
          repositoryInput={repositoryInput}
          state={state}
          nameErrorId={nameErrorId}
          testIds={testIds}
          props={props}
          groupGenerating={groupGenerating}
          setAddedPeople={setAddedPeople}
          setCollaboratorPickerOpen={setCollaboratorPickerOpen}
          setGroupEditorDraft={setGroupEditorDraft}
          targets={targets}
          cloudLocationDescription={cloudLocationDescription}
          resourceSetup={resourceSetup}
          people={people}
          configurationTarget={configurationTarget}
          setTemplateConfiguration={setTemplateConfiguration}
          collaboratorsLocked={collaboratorsLocked}
          selectedAgents={selectedAgents}
          groupGenerationRevealedAgentIdsRef={
            groupGenerationRevealedAgentIdsRef
          }
          setRevealedGenerationAgentIds={setRevealedGenerationAgentIds}
          setGroupGenerationError={setGroupGenerationError}
          setGroupModelPickerOpen={setGroupModelPickerOpen}
          groupedParticipants={groupedParticipants}
          participantName={participantName}
          inGroup={inGroup}
          directMembers={directMembers}
          removeMember={removeMember}
          directAgents={directAgents}
          removeAgent={removeAgent}
          collaboratorPickerOpen={collaboratorPickerOpen}
          availableAgents={availableAgents}
          addAgent={addAgent}
          importGroup={importGroup}
          generationModelsLoading={generationModelsLoading}
          openGroupModelPicker={openGroupModelPicker}
          groupRecommendationDismissed={groupRecommendationDismissed}
          setGroupRecommendationDismissed={setGroupRecommendationDismissed}
          groupGenerationError={groupGenerationError}
          advancedSettingsOpen={advancedSettingsOpen}
          setAdvancedSettingsOpen={setAdvancedSettingsOpen}
          providerSummary={providerSummary}
          providers={providers}
          groupEditorDraft={groupEditorDraft}
          requestProjectClose={requestProjectClose}
        />
        <div ref={setConfigurationTarget} style={{ display: "contents" }} />
        {groupConfiguration}
        {discardTarget && (
          <ProjectCreateDiscardView
            target={discardTarget}
            labels={labels}
            onKeepEditing={() => setDiscardTarget(null)}
            onDiscard={() => {
              setDiscardTarget(null);
              if (discardTarget === "group") closeGroupConfiguration();
              else onClose();
            }}
          />
        )}
      </>
    ),
  });
}
