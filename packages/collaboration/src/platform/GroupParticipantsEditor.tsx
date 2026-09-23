// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Bot, UserRound, Plus, Check, Copy, X } from "lucide-react";
import type { CollaborationGroup } from "../types";
import { CollaborationGroupRoster } from "./CollaborationGroupRoster";

export type GroupCandidate = {
  value: string;
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type GroupAgentAction = {
  id: "create" | "copy";
  label: string;
  description: string;
  onSelect(): void;
};

const copy = {
  "zh-CN": {
    leader: "负责人",
    makeLeader: "设为负责人",
    members: "协作小组成员",
    add: "添加成员",
    memberHint: "负责人接收任务并协调推进，可在成员行切换。",
    empty: "尚未添加其他成员",
    responsibility: "职责（选填）",
    responsibilityPlaceholder: "在小组中负责什么（可选）",
    search: "搜索成员或智能体",
    noResults: "没有匹配的成员或智能体",
    remove: "移除",
    human: "成员",
    agent: "智能体",
    agentActions: "添加智能体",
  },
  en: {
    leader: "Leader",
    makeLeader: "Make leader",
    members: "Team members",
    add: "Add members",
    memberHint:
      "The leader receives work and coordinates progress. Change it from any member row.",
    empty: "No additional members yet",
    responsibility: "Responsibility (optional)",
    responsibilityPlaceholder: "What will they own? (Optional)",
    search: "Search people or agents",
    noResults: "No matching people or agents",
    remove: "Remove",
    human: "Person",
    agent: "Agent",
    agentActions: "Add an agent",
  },
};

function Identity({
  candidate,
  locale,
}: {
  candidate: GroupCandidate;
  locale: keyof typeof copy;
}) {
  const Icon = candidate.kind === "agent" ? Bot : UserRound;
  return (
    <span className="collaboration-group-person">
      <span className="collaboration-group-person-icon">
        <Icon size={18} aria-hidden="true" />
      </span>
      <span>
        <strong>{candidate.name}</strong>
        <small>{copy[locale][candidate.kind]}</small>
      </span>
    </span>
  );
}

function ParticipantPicker({
  candidates,
  selected,
  locale,
  onSelect,
  agentActions = [],
}: {
  candidates: GroupCandidate[];
  selected: string[];
  locale: keyof typeof copy;
  onSelect(candidate: GroupCandidate, selected: boolean): void;
  agentActions?: GroupAgentAction[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const messages = copy[locale];
  const label = messages.add;
  const visible = candidates.filter((candidate) =>
    candidate.name
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="collaboration-group-people-action"
          data-testid="collaboration-group-create-add-members"
        >
          <Plus size={16} aria-hidden="true" />
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="collaboration-group-people-picker"
        align="end"
        side="bottom"
        sideOffset={6}
        avoidCollisions={false}
        collisionPadding={12}
        aria-label={messages.add}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[data-candidate]",
            ),
          );
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (!items.length) return;
          items[
            index < 0
              ? event.key === "ArrowDown"
                ? 0
                : items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length
          ]?.focus();
          event.preventDefault();
        }}
      >
        <input
          data-testid="collaboration-group-members-search"
          aria-label={messages.search}
          placeholder={messages.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div
          className="collaboration-group-people-options"
          role="group"
          aria-label={label}
        >
          {visible.map((candidate) => {
            const checked = selected.includes(candidate.value);
            return (
              <button
                type="button"
                key={candidate.value}
                data-candidate
                aria-pressed={checked}
                data-testid={`collaboration-group-create-member-${candidate.kind}-${candidate.id}`}
                onClick={() => {
                  onSelect(candidate, !checked);
                }}
              >
                <Identity candidate={candidate} locale={locale} />
                {checked && <Check size={16} aria-hidden="true" />}
              </button>
            );
          })}
          {!visible.length && <p>{messages.noResults}</p>}
        </div>
        {agentActions.length > 0 ? (
          <div className="collaboration-group-agent-actions">
            <span>{messages.agentActions}</span>
            {agentActions.map((action) => {
              const Icon = action.id === "copy" ? Copy : Bot;
              return (
                <button
                  type="button"
                  key={action.id}
                  data-testid={`collaboration-group-agent-action-${action.id}`}
                  onClick={() => {
                    setOpen(false);
                    action.onSelect();
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>
                    <strong>{action.label}</strong>
                    <small>{action.description}</small>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </Popover.Content>
    </Popover.Root>
  );
}

export function GroupParticipantsEditor({
  candidates,
  leader,
  members,
  locale,
  compact = false,
  onLeaderChange,
  onMemberChange,
  onResponsibilityChange,
  agentActions,
}: {
  candidates: GroupCandidate[];
  leader: string;
  members: CollaborationGroup["members"];
  locale: keyof typeof copy;
  compact?: boolean;
  onLeaderChange(candidate: GroupCandidate): void;
  onMemberChange(candidate: GroupCandidate, selected: boolean): void;
  onResponsibilityChange(
    candidate: GroupCandidate,
    responsibility: string,
  ): void;
  agentActions?: GroupAgentAction[];
}) {
  const messages = copy[locale];
  const selectedParticipants = candidates
    .filter(
      (candidate) =>
        candidate.value === leader ||
        members.some(
          (member) => `${member.kind}:${member.id}` === candidate.value,
        ),
    )
    .sort((left, right) => {
      if (left.value === leader) return -1;
      if (right.value === leader) return 1;
      return 0;
    });
  const selectedMembers = selectedParticipants.filter(
    (candidate) => candidate.value !== leader,
  );
  const selectedValues = selectedMembers.map((candidate) => candidate.value);
  const responsibility = (candidate: GroupCandidate) => (
    <label className="collaboration-group-person-responsibility">
      <span>{messages.responsibility}</span>
      <input
        data-testid={`collaboration-group-create-responsibility-${candidate.kind}-${candidate.id}`}
        aria-label={`${candidate.name} ${messages.responsibility}`}
        value={
          members.find(
            (member) => `${member.kind}:${member.id}` === candidate.value,
          )?.responsibility ?? ""
        }
        placeholder={messages.responsibilityPlaceholder}
        onChange={(event) =>
          onResponsibilityChange(candidate, event.target.value)
        }
      />
    </label>
  );
  return (
    <div
      className={`collaboration-group-people-editor${compact ? " is-compact" : ""}`}
    >
      <section aria-label={messages.members}>
        <div className="collaboration-group-people-heading">
          <div>
            <h4>
              {messages.members}
              {selectedParticipants.length > 0 && (
                <small>{selectedParticipants.length}</small>
              )}
            </h4>
            <p>{messages.memberHint}</p>
          </div>
          <ParticipantPicker
            candidates={candidates.filter(
              (candidate) => candidate.value !== leader,
            )}
            selected={selectedValues}
            locale={locale}
            onSelect={onMemberChange}
            agentActions={agentActions}
          />
        </div>
        <div className="collaboration-group-selected-people">
          <CollaborationGroupRoster
            locale={locale}
            participants={selectedParticipants.map((candidate) => ({
              ...candidate,
              leader: candidate.value === leader,
              className: "collaboration-group-person-card",
            }))}
            renderResponsibility={(candidate) => responsibility(candidate)}
            renderActions={(candidate) =>
              candidate.leader ? null : (
                <span className="collaboration-group-person-actions">
                  <button
                    type="button"
                    className="collaboration-group-people-action collaboration-group-make-leader"
                    aria-label={`${messages.makeLeader} ${messages[candidate.kind]} ${candidate.name}`}
                    title={messages.makeLeader}
                    data-testid={`collaboration-group-leader-${candidate.kind}-${candidate.id}`}
                    onClick={() => onLeaderChange(candidate)}
                  >
                    <span
                      className="collaboration-group-leader-indicator"
                      aria-hidden="true"
                    />
                    {messages.leader}
                  </button>
                  <button
                    type="button"
                    className="collaboration-group-people-action"
                    aria-label={`${messages.remove} ${messages[candidate.kind]} ${candidate.name}`}
                    title={`${messages.remove} ${candidate.name}`}
                    data-testid={`collaboration-group-remove-member-${candidate.kind}-${candidate.id}`}
                    onClick={() => onMemberChange(candidate, false)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </span>
              )
            }
          />
          {!selectedParticipants.length && (
            <p className="collaboration-group-people-empty">{messages.empty}</p>
          )}
        </div>
      </section>
    </div>
  );
}
