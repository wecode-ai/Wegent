// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Bot, Check, UserRound } from "lucide-react";

export interface CollaborationGroupRosterParticipant {
  kind: "human" | "agent";
  id: string;
  name: string;
  responsibility?: string;
  leader: boolean;
  className?: string;
}

export function CollaborationGroupRoster<
  Participant extends CollaborationGroupRosterParticipant,
>({
  participants,
  locale,
  testId,
  renderResponsibility,
  renderActions,
}: {
  participants: Participant[];
  locale: "zh-CN" | "en";
  testId?: string;
  renderResponsibility?(participant: Participant): ReactNode;
  renderActions?(participant: Participant): ReactNode;
}) {
  const ordered = [...participants].sort((left, right) => {
    if (left.leader === right.leader) return 0;
    return left.leader ? -1 : 1;
  });
  return (
    <div className="collaboration-group-roster" data-testid={testId}>
      {ordered.map((participant) => {
        const Icon = participant.kind === "agent" ? Bot : UserRound;
        const typeLabel =
          participant.kind === "agent"
            ? locale === "zh-CN"
              ? "智能体"
              : "Agent"
            : locale === "zh-CN"
              ? "成员"
              : "Person";
        return (
          <div
            key={`${participant.kind}:${participant.id}`}
            className={`collaboration-group-roster-item${participant.className ? ` ${participant.className}` : ""}`}
            data-leader={participant.leader || undefined}
            data-testid={
              participant.leader ? "collaboration-group-leader" : undefined
            }
          >
            <div className="collaboration-group-roster-heading">
              <span className="collaboration-group-roster-identity">
                <Icon aria-hidden="true" />
                <span>
                  <strong>{participant.name}</strong>
                  <small>{typeLabel}</small>
                </span>
              </span>
              {participant.leader ? (
                <span
                  className="collaboration-group-leader-badge"
                  data-testid={`collaboration-group-leader-${participant.kind}-${participant.id}`}
                >
                  <Check aria-hidden="true" />
                  {locale === "zh-CN" ? "负责人" : "Leader"}
                </span>
              ) : null}
              {renderActions?.(participant)}
            </div>
            {renderResponsibility?.(participant)}
          </div>
        );
      })}
    </div>
  );
}
