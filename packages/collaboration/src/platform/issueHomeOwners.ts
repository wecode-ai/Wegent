import type { CollaborationMember, CollaborationGroup } from "../types";
import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { ComposerExternalMentionCandidate } from "../composer/composerAutocompleteInputTypes";
import type { CollaborationTranslate } from "../i18n";

export interface IssueHomeOwner {
  kind: "user" | "agent" | "group";
  id: string;
}
export interface IssueHomeOwnerOption extends ComposerExternalMentionCandidate {
  owner: IssueHomeOwner;
}
export function issueHomeOwners(
  projectId: string,
  members: CollaborationMember[],
  agents: WorkspaceProjectAgent[],
  groups: CollaborationGroup[],
  translate: CollaborationTranslate,
): IssueHomeOwnerOption[] {
  const sources = [
    ...members.map((member) => ({
      kind: "user" as const,
      id: String(member.user_id),
      name: member.user_name,
    })),
    ...agents
      .filter(
        (agent) =>
          !agent.status ||
          agent.status === "active" ||
          agent.status === "available",
      )
      .map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        name: agent.name,
      })),
    ...groups.map((group) => ({
      kind: "group" as const,
      id: group.id,
      name: group.name,
    })),
  ];
  return sources.map(({ kind, id, name }) => ({
    id: `${kind}:${id}`,
    owner: { kind, id },
    type: kind,
    title: name,
    metaLabel: translate(`issue_creation.${kind}`),
    reference: `[$@${name.replace(/[\[\]\n]/g, "")}](wework-${kind === "user" ? "member" : kind}://${encodeURIComponent(projectId)}/${encodeURIComponent(id)})`,
    testId: `collaboration-home-mention-${kind === "user" ? "member" : kind}-${id}`,
    searchAliases: [name, id],
  }));
}
