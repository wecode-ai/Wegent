// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { DialogForm } from "../controls/DialogForm";

import * as Popover from "@radix-ui/react-popover";
import {
  ArrowRight,
  ArrowUp,
  Bot,
  ChevronDown,
  Cloud,
  GitBranch,
  Grid3X3,
  HardDrive,
  ListTodo,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  Sparkles,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { UnifiedModel } from "@wegent/chat-core/models";

import {
  ComposerTextInput,
  ProjectComposerBody,
  type ComposerInputHandle,
} from "../composer";
import { ModelSelector } from "../controls/ModelSelector";
import { createCollaborationTranslator } from "../i18n";
import { CollaborationGroupRoster } from "../platform/CollaborationGroupRoster";
import { useCollaborationPortalTheme } from "../theme";
import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateCollaborationGroupGenerationEvent,
  ProjectCreateDialogProps,
  ProjectCreateGenerationModel,
  ProjectCreateGenerationProgressPhase,
  ProjectCreateModalProps,
} from "./types";
import { useProjectCreateController } from "./useProjectCreateController";

function DefaultModal({ title, children, onClose }: ProjectCreateModalProps) {
  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-project-create-dialog"
        role="dialog"
        aria-modal="true"
        data-testid="collaboration-project-create-dialog"
      >
        <header className="collaboration-project-create-header">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ChoiceButton({
  testId,
  selected,
  icon,
  label,
  description,
  onClick,
}: {
  testId: string;
  selected: boolean;
  icon: ReactNode;
  label: string;
  description: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
      className={`collaboration-project-create-choice${selected ? " is-selected" : ""}`}
    >
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

function CollaboratorToken({
  icon,
  label,
  onRemove,
  removeLabel,
}: {
  icon: ReactNode;
  label: string;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <span className="collaboration-project-create-collaborator-token">
      {icon}
      <span>{label}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={removeLabel}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

function generationModelKey(model: {
  modelName: string;
  modelType?: string | null;
}) {
  return `${model.modelType ?? ""}:${model.modelName}`;
}

function HoverEditableText({
  value,
  ariaLabel,
  placeholder,
  testId,
  activateOnTextClick = false,
  showEditButton = false,
  multiline = true,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  testId?: string;
  activateOnTextClick?: boolean;
  showEditButton?: boolean;
  multiline?: boolean;
  onChange(value: string): void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    const sharedProps = {
      autoFocus: true,
      value,
      "aria-label": ariaLabel,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value),
      onBlur: () => setEditing(false),
      onKeyDown: (
        event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        if (event.key === "Escape") setEditing(false);
        if (!multiline && event.key === "Enter") setEditing(false);
      },
    };
    return multiline ? (
      <textarea
        {...sharedProps}
        className="collaboration-project-create-inline-textarea"
        rows={2}
      />
    ) : (
      <input
        {...sharedProps}
        className="collaboration-project-create-inline-input"
      />
    );
  }
  const startEditingFromText = () => {
    if (activateOnTextClick) setEditing(true);
  };
  return (
    <span
      className={`collaboration-project-create-hover-editable${
        showEditButton ? " is-edit-affordance-visible" : ""
      }`}
    >
      <span
        className={[
          !value && placeholder ? "is-placeholder" : "",
          activateOnTextClick ? "is-clickable" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role={activateOnTextClick ? "button" : undefined}
        tabIndex={activateOnTextClick ? 0 : undefined}
        data-testid={testId}
        onClick={startEditingFromText}
        onKeyDown={(event) => {
          if (
            activateOnTextClick &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            setEditing(true);
          }
        }}
      >
        {value || placeholder}
      </span>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
      >
        <Pencil aria-hidden="true" />
      </button>
    </span>
  );
}

function CollaborationGroupWorkflow({
  label,
  pendingLabel,
  stages,
  generating = false,
}: {
  label: string;
  pendingLabel: string;
  stages: Array<{ id: string; name: string }>;
  generating?: boolean;
}) {
  return (
    <div
      className={`collaboration-project-create-group-workflow${generating ? " is-generating" : ""}`}
      data-testid={
        generating
          ? "collaboration-project-create-generation-workflow"
          : undefined
      }
    >
      <small>{label}</small>
      {stages.length > 0 ? (
        <div>
          {stages.map((stage, index) => (
            <span key={stage.id}>
              <strong>{stage.name}</strong>
              {index < stages.length - 1 ? (
                <ArrowRight aria-hidden="true" />
              ) : null}
            </span>
          ))}
        </div>
      ) : generating ? (
        <span className="collaboration-project-create-workflow-pending">
          <LoaderCircle aria-hidden="true" className="collaboration-spin" />
          {pendingLabel}
        </span>
      ) : null}
    </div>
  );
}

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
  const portalTheme = useCollaborationPortalTheme();
  const translate = createCollaborationTranslator(labels.locale);
  const generationComposerRef = useRef<ComposerInputHandle>(null);
  const [collaboratorPickerOpen, setCollaboratorPickerOpen] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [groupRecommendationDismissed, setGroupRecommendationDismissed] =
    useState(false);
  const [groupEditorDraft, setGroupEditorDraft] =
    useState<ProjectCreateCollaborationGroupDraft | null>(null);
  const [groupModelPickerOpen, setGroupModelPickerOpen] = useState(false);
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
  const generationModelLoaderRef = useRef(
    resourceSetup?.loadCollaborationGroupGenerationModels,
  );
  const [generationModels, setGenerationModels] = useState<
    ProjectCreateGenerationModel[]
  >([]);
  const [generationModelsLoading, setGenerationModelsLoading] = useState(
    Boolean(generationModelLoaderRef.current),
  );
  const [selectedGenerationModelKey, setSelectedGenerationModelKey] =
    useState("");
  const [selectedGenerationModelOptions, setSelectedGenerationModelOptions] =
    useState<Record<string, string>>({});
  useEffect(() => {
    const loadModels = generationModelLoaderRef.current;
    if (!loadModels) return;
    let active = true;
    void loadModels()
      .then((catalog) => {
        if (!active) return;
        setGenerationModels(catalog.models);
        const defaultKey = catalog.defaultSelection
          ? generationModelKey(catalog.defaultSelection)
          : "";
        setSelectedGenerationModelKey(
          catalog.models.some(
            (candidate) => generationModelKey(candidate) === defaultKey,
          )
            ? defaultKey
            : catalog.models[0]
              ? generationModelKey(catalog.models[0])
              : "",
        );
        const defaultModel =
          catalog.models.find(
            (candidate) => generationModelKey(candidate) === defaultKey,
          ) ?? catalog.models[0];
        setSelectedGenerationModelOptions(defaultModel?.options ?? {});
      })
      .catch((cause) => {
        if (!active) return;
        setGroupGenerationError(
          host?.formatError?.(cause) ??
            (cause instanceof Error ? cause.message : labels.createFailed),
        );
      })
      .finally(() => {
        if (active) setGenerationModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [host, labels.createFailed]);
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
  const selectedMembers =
    resourceSetup?.members.filter(
      (member) =>
        member.user_id !== resourceSetup.currentUser.id &&
        state.memberUserIds.includes(member.user_id),
    ) ?? [];
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
        resourceSetup?.members.find((member) => String(member.user_id) === id)
          ?.user_name ?? id
      );
    }
    return resourceSetup?.agents.find((agent) => agent.id === id)?.name ?? id;
  };
  const removeMember = (userId: number) => {
    commands.setMemberUserIds(
      state.memberUserIds.filter((candidate) => candidate !== userId),
    );
    commands.setCollaborationGroupDraft(null);
  };
  const removeAgent = (resourceId: string) => {
    commands.setAgentResourceIds(
      state.agentResourceIds.filter((candidate) => candidate !== resourceId),
    );
    commands.setCollaborationGroupDraft(null);
  };
  const addAgent = (resourceId: string) => {
    commands.setAgentResourceIds([...state.agentResourceIds, resourceId]);
    commands.setCollaborationGroupDraft(null);
    setGroupRecommendationDismissed(false);
    setCollaboratorPickerOpen(false);
  };
  const importGroup = (groupId: string) => {
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
    commands.setMemberUserIds(humanIds);
    commands.setAgentResourceIds(agentIds);
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
      const selected = [current.leader, ...current.members].find(
        (candidate) =>
          candidate.kind === participant.kind &&
          candidate.id === participant.id,
      );
      if (!selected) return current;
      const previousLeader = current.leader;
      return {
        ...current,
        leader: selected,
        members: [
          previousLeader,
          ...current.members.filter(
            (candidate) =>
              candidate.kind !== participant.kind ||
              candidate.id !== participant.id,
          ),
        ].filter(
          (candidate, index, candidates) =>
            candidates.findIndex(
              (item) =>
                item.kind === candidate.kind && item.id === candidate.id,
            ) === index,
        ),
      };
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

  return renderModal({
    title: labels.title,
    onClose: () => {
      if (!state.saving) onClose();
    },
    children: (
      <DialogForm
        style={{ display: "contents" }}
        onSubmit={(event) => {
          event.preventDefault();
          void commands.submit();
        }}
      >
        <div className="collaboration-project-create-body">
          <label className="collaboration-project-create-field">
            <span>{labels.name}</span>
            <input
              data-testid={testIds?.name ?? "cloud-project-name"}
              value={state.name}
              onChange={(event) => {
                commands.setName(event.target.value);
                commands.clearError();
              }}
              placeholder={labels.namePlaceholder}
              autoFocus
            />
          </label>

          {targets.length > 1 ? (
            <section>
              <header className="collaboration-project-create-section-header">
                <h3>{labels.location}</h3>
                <small>{labels.locationImmutable}</small>
              </header>
              <div
                className={`collaboration-project-create-grid collaboration-project-create-locations columns-${targets.length}`}
              >
                {targets.map((target) => {
                  const isLocal = target.location === "local";
                  return (
                    <ChoiceButton
                      key={target.location}
                      testId={`cloud-project-location-${target.location}`}
                      selected={state.location === target.location}
                      icon={
                        isLocal ? (
                          <HardDrive aria-hidden="true" />
                        ) : (
                          <Cloud aria-hidden="true" />
                        )
                      }
                      label={
                        isLocal ? labels.localLocation : labels.cloudLocation
                      }
                      description={
                        isLocal
                          ? labels.localLocationDescription
                          : cloudLocationDescription
                      }
                      onClick={() => {
                        commands.setLocation(target.location);
                        commands.clearError();
                      }}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}

          {state.location === "cloud" && (
            <section>
              <h3>{labels.visibility}</h3>
              <div className="collaboration-project-create-grid columns-2">
                <ChoiceButton
                  testId="cloud-project-visibility-private"
                  selected={state.visibility === "private"}
                  icon={<LockKeyhole aria-hidden="true" />}
                  label={labels.privateVisibility}
                  description={labels.privateVisibilityDescription}
                  onClick={() => commands.setVisibility("private")}
                />
                <ChoiceButton
                  testId="cloud-project-visibility-public"
                  selected={state.visibility === "public"}
                  icon={<Cloud aria-hidden="true" />}
                  label={labels.publicVisibility}
                  description={labels.publicVisibilityDescription}
                  onClick={() => commands.setVisibility("public")}
                />
              </div>
              {state.visibility === "public" && (
                <p className="collaboration-project-create-hint">
                  {labels.publicVisibilityNotice}
                </p>
              )}
              {state.visibility === "public" && (
                <div>
                  <h3>{labels.publicAccessRole}</h3>
                  <div className="collaboration-project-create-grid columns-2">
                    <ChoiceButton
                      testId="cloud-project-public-access-viewer"
                      selected={state.publicAccessRole === "Viewer"}
                      icon={<LockKeyhole aria-hidden="true" />}
                      label={labels.viewerRole}
                      description={labels.viewerRoleDescription}
                      onClick={() => commands.setPublicAccessRole("Viewer")}
                    />
                    <ChoiceButton
                      testId="cloud-project-public-access-developer"
                      selected={state.publicAccessRole === "Developer"}
                      icon={<ListTodo aria-hidden="true" />}
                      label={labels.developerRole}
                      description={labels.developerRoleDescription}
                      onClick={() => commands.setPublicAccessRole("Developer")}
                    />
                  </div>
                </div>
              )}
              {!state.isAITableProvider && (
                <div>
                  <h3>{labels.defaultIssueSecurity}</h3>
                  <div className="collaboration-project-create-grid columns-2">
                    <ChoiceButton
                      testId="cloud-project-default-issue-security-open"
                      selected={state.defaultIssueSecurity === "open"}
                      icon={<Cloud aria-hidden="true" />}
                      label={labels.openIssueSecurity}
                      description={labels.openIssueSecurityDescription}
                      onClick={() => commands.setDefaultIssueSecurity("open")}
                    />
                    <ChoiceButton
                      testId="cloud-project-default-issue-security-related"
                      selected={state.defaultIssueSecurity === "related"}
                      icon={<LockKeyhole aria-hidden="true" />}
                      label={labels.relatedIssueSecurity}
                      description={labels.relatedIssueSecurityDescription}
                      onClick={() =>
                        commands.setDefaultIssueSecurity("related")
                      }
                    />
                  </div>
                </div>
              )}
            </section>
          )}

          {resourceSetup ? (
            <section className="collaboration-project-create-collaborators">
              <h3>{labels.collaborators}</h3>
              {state.collaborationGroupDraft ? (
                <div
                  className="collaboration-project-create-group-summary"
                  data-testid="collaboration-project-create-group-summary"
                >
                  <div className="collaboration-project-create-group-summary-header">
                    <span>
                      <UsersRound aria-hidden="true" />
                      <strong>{state.collaborationGroupDraft.name}</strong>
                    </span>
                    <button
                      type="button"
                      data-testid="collaboration-project-create-edit-group"
                      onClick={() => {
                        const agentIds = selectedAgents.map(
                          (agent) => agent.id,
                        );
                        groupGenerationRevealedAgentIdsRef.current = new Set(
                          agentIds,
                        );
                        setRevealedGenerationAgentIds(agentIds);
                        setGroupGenerationError(null);
                        setGroupEditorDraft(state.collaborationGroupDraft);
                        setGroupModelPickerOpen(true);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      {labels.editResponsibilities}
                    </button>
                  </div>
                  <div className="collaboration-project-create-group-members">
                    {groupedParticipants.map((participant) => {
                      const isLeader =
                        participant.kind ===
                          state.collaborationGroupDraft?.leader.kind &&
                        participant.id ===
                          state.collaborationGroupDraft?.leader.id;
                      return (
                        <span
                          key={`${participant.kind}:${participant.id}`}
                          className={isLeader ? "is-leader" : undefined}
                        >
                          {participant.kind === "agent" ? (
                            <Bot aria-hidden="true" />
                          ) : (
                            <UserRound aria-hidden="true" />
                          )}
                          <span>
                            <strong>
                              {participantName(
                                participant.kind,
                                participant.id,
                              )}
                            </strong>
                            <small>
                              {isLeader
                                ? labels.leaderWorks
                                : participant.responsibility ||
                                  labels.specialistWorks}
                            </small>
                          </span>
                        </span>
                      );
                    })}
                  </div>
                  {state.collaborationGroupDraft.instructions ? (
                    <div className="collaboration-project-create-group-principles">
                      <small>{labels.allocationPrinciples}</small>
                      <p>{state.collaborationGroupDraft.instructions}</p>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="collaboration-project-create-group-remove"
                    onClick={() => commands.setCollaborationGroupDraft(null)}
                  >
                    {labels.removeGroup}
                  </button>
                </div>
              ) : (
                <div className="collaboration-project-create-collaborator-tokens">
                  <CollaboratorToken
                    icon={<UserRound aria-hidden="true" />}
                    label={labels.currentUser}
                  />
                  {selectedMembers.map((member) => (
                    <CollaboratorToken
                      key={`member:${member.user_id}`}
                      icon={<UserRound aria-hidden="true" />}
                      label={member.user_name}
                      removeLabel={`${labels.cancel} ${member.user_name}`}
                      onRemove={() => removeMember(member.user_id)}
                    />
                  ))}
                  {selectedAgents.map((agent) => (
                    <CollaboratorToken
                      key={`agent:${agent.id}`}
                      icon={<Bot aria-hidden="true" />}
                      label={agent.name}
                      removeLabel={`${labels.cancel} ${agent.name}`}
                      onRemove={() => removeAgent(agent.id)}
                    />
                  ))}
                </div>
              )}
              <Popover.Root
                open={collaboratorPickerOpen}
                onOpenChange={setCollaboratorPickerOpen}
              >
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="collaboration-project-create-collaborator-trigger"
                    data-testid="collaboration-project-create-add-collaborator"
                    aria-expanded={collaboratorPickerOpen}
                  >
                    <Plus aria-hidden="true" />
                    <span>{labels.addCollaborator}</span>
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    {...portalTheme}
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    avoidCollisions={false}
                    className={`${portalTheme.className ?? ""} collaboration-project-create-collaborator-menu`}
                    data-testid="collaboration-project-create-collaborator-menu"
                  >
                    {resourceSetup.groups.length > 0 ? (
                      <div>
                        <small>{labels.availableGroups}</small>
                        {resourceSetup.groups.map((group) => (
                          <button
                            type="button"
                            key={group.id}
                            onClick={() => importGroup(group.id)}
                          >
                            <UsersRound aria-hidden="true" />
                            <span>
                              <strong>{group.name}</strong>
                              <small>{labels.importGroupDescription}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {availableAgents.length > 0 ? (
                      <div>
                        <small>{labels.availableAgents}</small>
                        {availableAgents.map((agent) => (
                          <button
                            type="button"
                            key={agent.id}
                            data-testid={`collaboration-project-create-agent-${agent.id}`}
                            onClick={() => addAgent(agent.id)}
                          >
                            <Bot aria-hidden="true" />
                            <span>
                              <strong>{agent.name}</strong>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {selectedAgents.length > 0 &&
                    resourceSetup.generateCollaborationGroupDraft ? (
                      <div>
                        <button
                          type="button"
                          data-testid="collaboration-project-create-new-group"
                          disabled={groupGenerating || generationModelsLoading}
                          onClick={openGroupModelPicker}
                        >
                          {groupGenerating ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="collaboration-spin"
                            />
                          ) : (
                            <Sparkles aria-hidden="true" />
                          )}
                          <span>
                            <strong>{labels.createCollaborationGroup}</strong>
                            <small>
                              {groupGenerating
                                ? labels.generatingGroup
                                : labels.groupRecommendationDescription}
                            </small>
                          </span>
                        </button>
                      </div>
                    ) : null}
                    {resourceSetup.groups.length === 0 &&
                    availableAgents.length === 0 ? (
                      <p>{labels.noAvailableCollaborators}</p>
                    ) : null}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              {!state.collaborationGroupDraft &&
              selectedAgents.length >= 2 &&
              resourceSetup.generateCollaborationGroupDraft &&
              !groupModelPickerOpen &&
              !groupRecommendationDismissed ? (
                <div
                  className="collaboration-project-create-group-recommendation"
                  data-testid="collaboration-project-create-group-recommendation"
                >
                  <Sparkles aria-hidden="true" />
                  <div>
                    <strong>{labels.groupRecommendationTitle}</strong>
                    <p>{labels.groupRecommendationDescription}</p>
                    <span>
                      <button
                        type="button"
                        onClick={() => setGroupRecommendationDismissed(true)}
                      >
                        {labels.keepDirectCollaboration}
                      </button>
                      <button
                        type="button"
                        className="collaboration-primary-button"
                        data-testid="collaboration-project-create-organize-group"
                        disabled={groupGenerating}
                        onClick={openGroupModelPicker}
                      >
                        {groupGenerating
                          ? labels.generatingGroup
                          : labels.organizeAsGroup}
                      </button>
                    </span>
                  </div>
                </div>
              ) : null}
              {groupGenerationError ? (
                <p
                  className="collaboration-project-create-inline-error"
                  role="alert"
                >
                  {groupGenerationError}
                </p>
              ) : null}
            </section>
          ) : null}

          {groupModelPickerOpen && typeof document !== "undefined"
            ? createPortal(
                <div className="collaboration-project-create-group-dialog-backdrop z-system">
                  <section
                    className="collaboration-project-create-group-editor is-generator is-dialog"
                    data-testid="collaboration-project-create-model-picker"
                    role="dialog"
                    aria-modal="true"
                    aria-label={labels.selectGenerationModel}
                  >
                    <header>
                      <span>
                        <Sparkles aria-hidden="true" />
                        <strong>
                          {groupEditorDraft
                            ? labels.groupDraftTitle
                            : labels.selectGenerationModel}
                        </strong>
                      </span>
                      <button
                        type="button"
                        aria-label={labels.cancel}
                        onClick={() => {
                          groupGenerationRunRef.current += 1;
                          if (groupGenerationAgentTimerRef.current !== null) {
                            window.clearTimeout(
                              groupGenerationAgentTimerRef.current,
                            );
                            groupGenerationAgentTimerRef.current = null;
                          }
                          groupGenerationAgentQueueRef.current = [];
                          groupGenerationQueuedAgentIdsRef.current.clear();
                          groupGenerationAgentSettlingRef.current = false;
                          setGroupModelPickerOpen(false);
                          setGroupEditorDraft(null);
                          setGroupGenerating(false);
                          setGroupGenerationPhase(null);
                        }}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </header>
                    {groupGenerationError ? (
                      <p
                        className="collaboration-project-create-inline-error"
                        role="alert"
                      >
                        {groupGenerationError}
                      </p>
                    ) : null}
                    {!groupGenerating && !groupEditorDraft ? (
                      <ProjectComposerBody
                        ref={generationComposerRef}
                        translate={translate}
                        value={groupGenerationInstructions}
                        onChange={setGroupGenerationInstructions}
                        onSubmit={(value) =>
                          void openGeneratedGroupDraft(value)
                        }
                        disabled={false}
                        requireText
                        embeddedInForm
                        isModelSelectionReady={
                          !generationModelsLoading &&
                          generationModels.length > 0
                        }
                        placeholder={labels.generationRequestPlaceholder}
                        inputTestId="collaboration-project-create-generation-instructions"
                        attachments={[]}
                        uploadingCount={0}
                        attachmentErrorCount={0}
                        onFileSelect={() => {}}
                        onRemoveAttachment={() => {}}
                        renderAttachments={() => (
                          <div
                            className="mb-2 flex flex-wrap items-center gap-2"
                            data-testid="collaboration-project-create-generation-agent-attachments"
                          >
                            {selectedAgents.map((agent) => (
                              <span
                                key={agent.id}
                                className="inline-flex h-12 min-w-36 max-w-52 items-center gap-2 rounded-xl border border-border/70 bg-background px-2.5 shadow-sm"
                              >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary">
                                  <Bot className="h-4 w-4" aria-hidden="true" />
                                </span>
                                <span className="flex min-w-0 flex-col text-left">
                                  <strong
                                    className="truncate text-sm font-medium text-text-primary"
                                    title={agent.name}
                                  >
                                    {agent.name}
                                  </strong>
                                  <small className="text-xs text-text-muted">
                                    {labels.agentAttachment}
                                  </small>
                                </span>
                              </span>
                            ))}
                            {selectedGenerationHumans.map((member) => (
                              <span
                                key={`human:${member.id}`}
                                className="inline-flex h-12 min-w-36 max-w-52 items-center gap-2 rounded-xl border border-border/70 bg-background px-2.5 shadow-sm"
                              >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary">
                                  <UserRound
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                </span>
                                <span className="flex min-w-0 flex-col text-left">
                                  <strong
                                    className="truncate text-sm font-medium text-text-primary"
                                    title={member.name}
                                  >
                                    {member.name}
                                  </strong>
                                  <small className="text-xs text-text-muted">
                                    {labels.memberAttachment}
                                  </small>
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                        renderEditor={(editorProps) => (
                          <ComposerTextInput {...editorProps} />
                        )}
                        renderToolbar={(toolbarProps) => (
                          <div
                            className={`${toolbarProps.className} flex items-center justify-end gap-1.5`}
                            data-testid="collaboration-project-create-generation-toolbar"
                          >
                            <ModelSelector
                              translate={translate}
                              isMobile={false}
                              onOpenModelSettings={() => {}}
                              models={unifiedGenerationModels}
                              selectedModel={selectedUnifiedGenerationModel}
                              selectedModelOptions={
                                selectedGenerationModelOptions
                              }
                              disabled={generationModelsLoading}
                              menuPlacement="above"
                              onSelectModel={(model) => {
                                if (!model) return false;
                                const key = generationModelKey({
                                  modelName: model.name,
                                  modelType: model.type,
                                });
                                const source = generationModels.find(
                                  (candidate) =>
                                    generationModelKey(candidate) === key,
                                );
                                setSelectedGenerationModelKey(key);
                                setSelectedGenerationModelOptions(
                                  source?.options ?? {},
                                );
                                setGroupGenerationError(null);
                                return true;
                              }}
                              onSelectModelAndOptions={(model, options) => {
                                setSelectedGenerationModelKey(
                                  generationModelKey({
                                    modelName: model.name,
                                    modelType: model.type,
                                  }),
                                );
                                setSelectedGenerationModelOptions(options);
                                setGroupGenerationError(null);
                              }}
                              onSelectModelOption={(optionId, value) =>
                                setSelectedGenerationModelOptions(
                                  (current) => ({
                                    ...current,
                                    [optionId]: value,
                                  }),
                                )
                              }
                            />
                            <button
                              type="button"
                              data-composer-primary-action="true"
                              data-testid="collaboration-project-create-generate-group"
                              disabled={!toolbarProps.canSend}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => toolbarProps.onSubmit()}
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-primary p-0 text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:bg-text-muted/45"
                              aria-label={labels.generateResponsibilities}
                            >
                              <ArrowUp className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      />
                    ) : null}
                    {groupGenerating || groupEditorDraft ? (
                      <div
                        className={`collaboration-project-create-generation-progress${groupEditorDraft ? " is-complete" : ""}`}
                        data-testid={
                          groupEditorDraft
                            ? "collaboration-project-create-group-editor"
                            : "collaboration-project-create-generation-progress"
                        }
                      >
                        <header>
                          {groupEditorDraft ? (
                            <Sparkles aria-hidden="true" />
                          ) : (
                            <LoaderCircle
                              aria-hidden="true"
                              className="collaboration-spin"
                            />
                          )}
                          <span>
                            {groupEditorDraft ? (
                              <>
                                <strong>
                                  <HoverEditableText
                                    value={groupEditorDraft.name}
                                    activateOnTextClick
                                    showEditButton
                                    testId="collaboration-project-create-group-name"
                                    multiline={false}
                                    ariaLabel={`${labels.editResponsibilities} ${labels.groupName}`}
                                    onChange={(name) =>
                                      setGroupEditorDraft((current) =>
                                        current
                                          ? { ...current, name }
                                          : current,
                                      )
                                    }
                                  />
                                </strong>
                                <small>{labels.groupDraftTitle}</small>
                              </>
                            ) : (
                              <>
                                <strong>{generationPhaseLabel}</strong>
                                <small>
                                  {labels.generationElapsed.replace(
                                    "{{seconds}}",
                                    String(groupGenerationElapsedSeconds),
                                  )}
                                </small>
                              </>
                            )}
                          </span>
                        </header>
                        <div className="collaboration-project-create-squad-formation">
                          {!groupEditorDraft ? (
                            <>
                              <div
                                className="collaboration-project-create-assignment-queue"
                                data-testid="collaboration-project-create-assignment-queue"
                              >
                                <header>
                                  <span>
                                    <Sparkles aria-hidden="true" />
                                    <strong>
                                      {labels.waitingForAssignment}
                                    </strong>
                                  </span>
                                  <small>
                                    {labels.automaticAssignmentHint}
                                  </small>
                                </header>
                                <span>
                                  {selectedAgents
                                    .filter(
                                      (agent) =>
                                        !assignedAgentIds.has(agent.id),
                                    )
                                    .map((agent) => (
                                      <span
                                        key={agent.id}
                                        className="is-waiting"
                                        style={{
                                          animationDelay: `${
                                            selectedAgents.findIndex(
                                              (candidate) =>
                                                candidate.id === agent.id,
                                            ) * 90
                                          }ms`,
                                        }}
                                      >
                                        <span className="collaboration-project-create-member-token">
                                          <Bot aria-hidden="true" />
                                          <strong>{agent.name}</strong>
                                        </span>
                                      </span>
                                    ))}
                                </span>
                              </div>
                            </>
                          ) : null}
                          <div className="is-squad">
                            <small>{labels.formingGroup}</small>
                            <CollaborationGroupRoster
                              locale={labels.locale}
                              testId="collaboration-project-create-group-roster"
                              participants={visibleGroupParticipants}
                              renderActions={(participant) =>
                                participant.draftParticipant &&
                                !participant.leader ? (
                                  <button
                                    type="button"
                                    className="collaboration-project-create-set-leader"
                                    onClick={() =>
                                      setGroupLeader(
                                        participant.draftParticipant!,
                                      )
                                    }
                                  >
                                    {labels.setAsLeader}
                                  </button>
                                ) : null
                              }
                              renderResponsibility={(participant) =>
                                !participant.leader &&
                                (participant.draftParticipant ||
                                  participant.responsibility) ? (
                                  <span
                                    className="collaboration-project-create-duty-bubble"
                                    role="status"
                                  >
                                    {participant.draftParticipant ? (
                                      <HoverEditableText
                                        value={
                                          participant.draftParticipant
                                            .responsibility
                                        }
                                        placeholder={
                                          labels.supplementResponsibility
                                        }
                                        ariaLabel={`${participant.name} ${labels.editResponsibilities}`}
                                        onChange={(responsibility) =>
                                          updateGroupParticipant(
                                            participant.draftParticipant!,
                                            responsibility,
                                          )
                                        }
                                      />
                                    ) : (
                                      participant.responsibility
                                    )}
                                  </span>
                                ) : null
                              }
                            />
                          </div>
                        </div>
                        {groupEditorDraft ? (
                          <div className="collaboration-project-create-generated-details">
                            <section
                              className="collaboration-project-create-generated-principles"
                              data-testid="collaboration-project-create-group-instructions"
                            >
                              <small>{labels.allocationPrinciples}</small>
                              <HoverEditableText
                                value={groupEditorDraft.instructions}
                                placeholder={
                                  labels.supplementAllocationPrinciples
                                }
                                ariaLabel={`${labels.editResponsibilities} ${labels.allocationPrinciples}`}
                                onChange={(instructions) =>
                                  setGroupEditorDraft((current) =>
                                    current
                                      ? { ...current, instructions }
                                      : current,
                                  )
                                }
                              />
                            </section>
                            {groupEditorDraft.stages.length > 0 ? (
                              <CollaborationGroupWorkflow
                                label={labels.generatedWorkflow}
                                pendingLabel={labels.generatingWorkflow}
                                stages={groupEditorDraft.stages}
                              />
                            ) : null}
                            <footer className="collaboration-project-create-generated-footer">
                              <small>{labels.groupSettingsHint}</small>
                              <button
                                type="button"
                                className="collaboration-primary-button"
                                data-testid="collaboration-project-create-apply-group"
                                disabled={!groupEditorDraft.name.trim()}
                                onClick={() => {
                                  commands.setCollaborationGroupDraft({
                                    ...groupEditorDraft,
                                    name: groupEditorDraft.name.trim(),
                                  });
                                  setGroupEditorDraft(null);
                                  setGroupModelPickerOpen(false);
                                  setGroupRecommendationDismissed(true);
                                }}
                              >
                                {labels.applyGroup}
                              </button>
                            </footer>
                          </div>
                        ) : (
                          <div className="collaboration-project-create-live-output">
                            <section>
                              <small>{labels.allocationPrinciples}</small>
                              {groupGenerationPrinciples.length > 0 ? (
                                <ul>
                                  {groupGenerationPrinciples.map(
                                    (principle, index) => (
                                      <li key={`${index}:${principle}`}>
                                        {principle}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              ) : (
                                <span>{labels.generatingResponsibilities}</span>
                              )}
                            </section>
                            <CollaborationGroupWorkflow
                              label={labels.generatedWorkflow}
                              pendingLabel={labels.generatingWorkflow}
                              stages={groupGenerationStages}
                              generating
                            />
                          </div>
                        )}
                      </div>
                    ) : null}
                  </section>
                </div>,
                document.body,
              )
            : null}

          <section className="collaboration-project-create-advanced">
            <button
              type="button"
              className="collaboration-project-create-advanced-trigger"
              aria-expanded={advancedSettingsOpen}
              data-testid="collaboration-project-create-advanced"
              onClick={() => setAdvancedSettingsOpen((current) => !current)}
            >
              <span>{labels.advancedSettings}</span>
              <ChevronDown aria-hidden="true" />
            </button>
            {advancedSettingsOpen ? (
              <div className="collaboration-project-create-advanced-content">
                <label className="collaboration-project-create-field">
                  <span>
                    {labels.description} <small>{labels.optional}</small>
                  </span>
                  <textarea
                    data-testid={
                      testIds?.description ?? "cloud-project-description"
                    }
                    value={state.description}
                    onChange={(event) =>
                      commands.setDescription(event.target.value)
                    }
                    placeholder={labels.descriptionPlaceholder}
                  />
                </label>
                <section>
                  <h3>{labels.taskProvider}</h3>
                  <div className="collaboration-project-create-grid collaboration-project-create-providers">
                    {providers.map((provider) => (
                      <ChoiceButton
                        key={provider.id}
                        testId={`cloud-project-task-provider-${provider.id}`}
                        selected={state.taskProvider === provider.id}
                        icon={provider.icon}
                        label={provider.label}
                        description={provider.description}
                        onClick={() => {
                          commands.setTaskProvider(provider.id);
                          commands.clearError();
                        }}
                      />
                    ))}
                  </div>
                </section>

                {state.repositoryProvider ? (
                  <section className="collaboration-project-create-provider-config">
                    <label className="collaboration-project-create-field">
                      <span>{labels.repository}</span>
                      <input
                        data-testid="cloud-project-provider-repository"
                        value={state.repositoryAddress}
                        onChange={(event) => {
                          commands.setRepositoryAddress(event.target.value);
                          commands.clearError();
                        }}
                        placeholder={
                          state.taskProvider === "github"
                            ? "https://github.com/owner/repository"
                            : "https://gitlab.com/group/project"
                        }
                      />
                      <small>{labels.repositoryHint}</small>
                    </label>
                    <label className="collaboration-project-create-field">
                      <span>
                        {labels.token} <small>{labels.optional}</small>
                      </span>
                      <div className="collaboration-project-create-token">
                        <LockKeyhole aria-hidden="true" />
                        <input
                          data-testid="cloud-project-provider-token"
                          type="password"
                          autoComplete="new-password"
                          value={state.token}
                          onChange={(event) =>
                            commands.setToken(event.target.value)
                          }
                          placeholder={labels.privateRepositoryToken}
                        />
                      </div>
                      <small>
                        {state.location === "cloud"
                          ? labels.cloudTokenHint
                          : labels.localTokenHint}
                      </small>
                    </label>
                  </section>
                ) : null}

                {state.isAITableProvider ? (
                  <section className="collaboration-project-create-provider-config">
                    <label className="collaboration-project-create-field">
                      <span>{labels.aitableUrl}</span>
                      <input
                        data-testid="cloud-project-aitable-url"
                        value={state.aitableUrl}
                        onChange={(event) => {
                          commands.setAitableUrl(event.target.value);
                          commands.clearError();
                        }}
                        placeholder={labels.aitablePlaceholder}
                      />
                      <small
                        className={
                          state.aitableUrl && !state.aitableLink
                            ? "is-error"
                            : ""
                        }
                      >
                        {state.aitableUrl && !state.aitableLink
                          ? labels.aitableInvalid
                          : labels.aitableHint}
                      </small>
                    </label>
                    <p className="collaboration-project-create-hint">
                      {labels.aitableRuntimeHint}
                    </p>
                  </section>
                ) : null}
              </div>
            ) : null}
          </section>

          {state.error && (
            <p className="collaboration-project-create-error" role="alert">
              {state.error}
            </p>
          )}
        </div>
        {!groupEditorDraft && !groupModelPickerOpen ? (
          <footer className="collaboration-project-create-footer">
            <button
              type="button"
              disabled={state.saving}
              onClick={() => {
                if (!state.saving) onClose();
              }}
            >
              {labels.cancel}
            </button>
            <button
              type="submit"
              className="collaboration-primary-button"
              data-testid={testIds?.confirm ?? "cloud-project-create-confirm"}
              disabled={!state.canSubmit}
            >
              {state.saving ? labels.creating : labels.create}
            </button>
          </footer>
        ) : null}
      </DialogForm>
    ),
  });
}
