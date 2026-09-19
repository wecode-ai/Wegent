// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Bot, UserRound, Plus, ChevronDown, Check, X } from "lucide-react";
import type { CollaborationGroup } from "../types";

export type GroupCandidate = {
  value: string;
  kind: "human" | "agent";
  id: string;
  name: string;
};

const copy = {
  "zh-CN": {
    leader: "负责人",
    leaderHint: "协调分工，推动协作小组完成目标。",
    choose: "选择负责人",
    change: "更换",
    members: "协作小组成员",
    add: "添加成员",
    memberHint: "负责人已加入协作小组，无需重复添加。",
    empty: "按需添加一起协作的人或智能体，也可以只由负责人开始。",
    responsibility: "职责（选填）",
    memberExample: "例如：实现功能、代码审查",
    search: "搜索成员或智能体",
    noResults: "没有匹配的成员或智能体",
    remove: "移除",
    done: "完成",
    human: "成员",
    agent: "智能体",
  },
  en: {
    leader: "Leader",
    leaderHint: "Coordinate the team and guide work toward its goal.",
    choose: "Choose a leader",
    change: "Change",
    members: "Team members",
    add: "Add members",
    memberHint: "The leader is already included in the team.",
    empty:
      "Add people or agents to collaborate, or start with just the leader.",
    responsibility: "Responsibility (optional)",
    memberExample: "E.g. implementation or code review",
    search: "Search people or agents",
    noResults: "No matching people or agents",
    remove: "Remove",
    done: "Done",
    human: "Person",
    agent: "Agent",
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
  mode,
  candidates,
  selected,
  locale,
  onSelect,
}: {
  mode: "leader" | "members";
  candidates: GroupCandidate[];
  selected: string[];
  locale: keyof typeof copy;
  onSelect(candidate: GroupCandidate, selected: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const messages = copy[locale];
  const label =
    mode === "leader"
      ? selected.length
        ? messages.change
        : messages.choose
      : messages.add;
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
          data-testid={
            mode === "leader"
              ? "collaboration-group-leader"
              : "collaboration-group-create-add-members"
          }
        >
          {mode === "members" && <Plus size={16} aria-hidden="true" />}
          {label}
          {mode === "leader" && <ChevronDown size={14} aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="collaboration-group-people-picker"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        aria-label={mode === "leader" ? messages.choose : messages.add}
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
          data-testid={`collaboration-group-${mode}-search`}
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
                data-testid={
                  mode === "leader"
                    ? `collaboration-group-leader-${candidate.kind}-${candidate.id}`
                    : `collaboration-group-create-member-${candidate.kind}-${candidate.id}`
                }
                onClick={() => {
                  onSelect(candidate, !checked);
                  if (mode === "leader") setOpen(false);
                }}
              >
                <Identity candidate={candidate} locale={locale} />
                {checked && <Check size={16} aria-hidden="true" />}
              </button>
            );
          })}
          {!visible.length && <p>{messages.noResults}</p>}
        </div>
        {mode === "members" && (
          <Popover.Close asChild>
            <button
              type="button"
              className="collaboration-group-people-action"
              data-testid="collaboration-group-members-done"
            >
              {messages.done}
            </button>
          </Popover.Close>
        )}
      </Popover.Content>
    </Popover.Root>
  );
}

export function GroupParticipantsEditor({
  candidates,
  leader,
  members,
  locale,
  onLeaderChange,
  onMemberChange,
  onResponsibilityChange,
}: {
  candidates: GroupCandidate[];
  leader: string;
  members: CollaborationGroup["members"];
  locale: keyof typeof copy;
  onLeaderChange(candidate: GroupCandidate): void;
  onMemberChange(candidate: GroupCandidate, selected: boolean): void;
  onResponsibilityChange(
    candidate: GroupCandidate,
    responsibility: string,
  ): void;
}) {
  const messages = copy[locale];
  const selectedLeader = candidates.find(
    (candidate) => candidate.value === leader,
  );
  const selectedMembers = candidates.filter(
    (candidate) =>
      candidate.value !== leader &&
      members.some(
        (member) => `${member.kind}:${member.id}` === candidate.value,
      ),
  );
  const responsibility = (candidate: GroupCandidate) => (
    <label className="collaboration-group-person-responsibility">
      <span>{messages.responsibility}</span>
      <input
        data-testid={`collaboration-group-create-responsibility-${candidate.kind}-${candidate.id}`}
        value={
          members.find(
            (member) => `${member.kind}:${member.id}` === candidate.value,
          )?.responsibility ?? ""
        }
        placeholder={messages.memberExample}
        onChange={(event) =>
          onResponsibilityChange(candidate, event.target.value)
        }
      />
    </label>
  );
  return (
    <div className="collaboration-group-people-editor">
      <section aria-label={messages.leader}>
        <div className="collaboration-group-people-heading">
          <div>
            <h4>{messages.leader}</h4>
            <p>{messages.leaderHint}</p>
          </div>
        </div>
        <div className="collaboration-group-person-card">
          <div className="collaboration-group-person-toolbar">
            {selectedLeader ? (
              <Identity candidate={selectedLeader} locale={locale} />
            ) : (
              <span className="collaboration-group-person-empty">
                {messages.choose}
              </span>
            )}
            <ParticipantPicker
              mode="leader"
              candidates={candidates}
              selected={leader ? [leader] : []}
              locale={locale}
              onSelect={onLeaderChange}
            />
          </div>
        </div>
      </section>
      <section aria-label={messages.members}>
        <div className="collaboration-group-people-heading">
          <div>
            <h4>
              {messages.members}
              {selectedMembers.length > 0 && (
                <small>{selectedMembers.length}</small>
              )}
            </h4>
            <p>{messages.memberHint}</p>
          </div>
          <ParticipantPicker
            mode="members"
            candidates={candidates.filter(
              (candidate) => candidate.value !== leader,
            )}
            selected={selectedMembers.map((candidate) => candidate.value)}
            locale={locale}
            onSelect={onMemberChange}
          />
        </div>
        <div className="collaboration-group-selected-people">
          {selectedMembers.map((candidate) => (
            <div
              key={candidate.value}
              className="collaboration-group-person-card"
            >
              <div className="collaboration-group-person-toolbar">
                <Identity candidate={candidate} locale={locale} />
                <button
                  type="button"
                  className="collaboration-group-people-action"
                  aria-label={`${messages.remove} ${candidate.name}`}
                  title={`${messages.remove} ${candidate.name}`}
                  data-testid={`collaboration-group-remove-member-${candidate.kind}-${candidate.id}`}
                  onClick={() => onMemberChange(candidate, false)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
              {responsibility(candidate)}
            </div>
          ))}
          {!selectedMembers.length && (
            <p className="collaboration-group-people-empty">{messages.empty}</p>
          )}
        </div>
      </section>
    </div>
  );
}
