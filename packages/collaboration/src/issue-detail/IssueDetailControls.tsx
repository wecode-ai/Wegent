// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ChangeEventHandler } from "react";

import type {
  CollaborationAgent,
  CollaborationMember,
  CollaborationPriority,
  CollaborationStatus,
} from "../types";
import type { IssueAssigneeTarget } from "./IssueDetailDraft";

export interface IssueDetailSelectProps<TValue extends string> {
  value: TValue;
  options: Array<{ value: TValue; label: string }>;
  testId: string;
  accessibleLabel: string;
  className?: string;
  disabled?: boolean;
  includeUnset?: boolean;
  unsetLabel?: string;
  onChange(value: TValue): void;
}

export function IssueDetailSelect<TValue extends string>({
  value,
  options,
  testId,
  accessibleLabel,
  className,
  disabled,
  includeUnset,
  unsetLabel = "未设置",
  onChange,
}: IssueDetailSelectProps<TValue>) {
  const handleChange: ChangeEventHandler<HTMLSelectElement> = (event) => {
    onChange(event.target.value as TValue);
  };
  return (
    <select
      data-testid={testId}
      aria-label={accessibleLabel}
      value={value}
      onChange={handleChange}
      disabled={disabled}
      className={className}
    >
      {includeUnset ? <option value="">{unsetLabel}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function IssueDetailStatusSelect({
  statuses,
  ...props
}: Omit<IssueDetailSelectProps<string>, "options"> & {
  statuses: Array<Pick<CollaborationStatus, "id" | "name">>;
}) {
  return (
    <IssueDetailSelect
      {...props}
      options={statuses.map((status) => ({
        value: status.id,
        label: status.name,
      }))}
    />
  );
}

export function IssueDetailPrioritySelect({
  labels,
  ...props
}: Omit<IssueDetailSelectProps<CollaborationPriority>, "options"> & {
  labels: Record<CollaborationPriority, string>;
}) {
  return (
    <IssueDetailSelect
      {...props}
      options={(["none", "low", "medium", "high", "urgent"] as const).map(
        (value) => ({
          value,
          label: labels[value],
        }),
      )}
    />
  );
}

export interface IssueDetailAssigneeTeam {
  id: number;
  name: string;
  displayName?: string | null;
}

export interface IssueDetailAssigneeSelectProps {
  value: IssueAssigneeTarget;
  members: Array<Pick<CollaborationMember, "user_id" | "user_name">>;
  agents: Array<Pick<CollaborationAgent, "id" | "name">>;
  teams?: IssueDetailAssigneeTeam[];
  testId: string;
  accessibleLabel: string;
  className?: string;
  disabled?: boolean;
  labels: {
    empty: string;
    members: string;
    agents: string;
    teams: string;
  };
  onChange(value: IssueAssigneeTarget): void;
}

export function IssueDetailAssigneeSelect({
  value,
  members,
  agents,
  teams = [],
  testId,
  accessibleLabel,
  className,
  disabled,
  labels,
  onChange,
}: IssueDetailAssigneeSelectProps) {
  return (
    <select
      data-testid={testId}
      aria-label={accessibleLabel}
      value={value}
      onChange={(event) => onChange(event.target.value as IssueAssigneeTarget)}
      disabled={disabled}
      className={className}
    >
      <option value="">{labels.empty}</option>
      <optgroup label={labels.members}>
        {members.map((member) => (
          <option key={member.user_id} value={`user:${member.user_id}`}>
            {member.user_name}
          </option>
        ))}
      </optgroup>
      {agents.length ? (
        <optgroup label={labels.agents}>
          {agents.map((agent) => (
            <option key={agent.id} value={`agent:${agent.id}`}>
              {agent.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {teams.length ? (
        <optgroup label={labels.teams}>
          {teams.map((team) => (
            <option key={team.id} value={`team:${team.id}`}>
              {team.displayName || team.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}
