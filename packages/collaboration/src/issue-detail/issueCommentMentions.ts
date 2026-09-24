import type { ComposerExternalMentionCandidate } from "../composer/composerAutocompleteInputTypes";
import { parseComposerReferences } from "../composer/composerReference";

/**
 * A structured "@" target: the composer shows the label, and the comment carries
 * the member or robot it stands for.
 */
export interface IssueMentionOption {
  type: "user" | "agent";
  id: string;
  label: string;
}

/**
 * The schemes a comment mention travels as.
 *
 * A pick becomes a reference the shared composer renders as a chip and writes
 * into markdown, which is what keeps the comment's "@" the same as the home
 * composer's instead of a second, plain-text mention.
 */
const MENTION_SCHEMES: [string, IssueMentionOption["type"]][] = [
  ["wework-member://", "user"],
  ["wework-agent://", "agent"],
];

/** The mention menu rows for one project's members and robots. */
export function issueMentionCandidates({
  members,
  agents,
  membersLabel,
  agentsLabel,
}: {
  members: { user_id: number; user_name: string }[];
  agents: { id: string; name: string }[];
  membersLabel: string;
  agentsLabel: string;
}): ComposerExternalMentionCandidate[] {
  return [
    ...members.map((member) => ({
      id: String(member.user_id),
      type: "user" as const,
      title: member.user_name,
      metaLabel: membersLabel,
      reference: issueMentionReference(
        "member",
        member.user_name,
        member.user_id,
      ),
      testId: `collaboration-issue-mention-member-${member.user_id}`,
    })),
    ...agents.map((agent) => ({
      id: String(agent.id),
      type: "agent" as const,
      title: agent.name,
      metaLabel: agentsLabel,
      reference: issueMentionReference("agent", agent.name, agent.id),
      testId: `collaboration-issue-mention-agent-${agent.id}`,
    })),
  ];
}

/** The reference a picked member or robot is written as. */
function issueMentionReference(
  kind: "member" | "agent",
  name: string,
  id: string | number,
): string {
  return `[$@${name.replace(/[\[\]\n]/g, "")}](wework-${kind}://${encodeURIComponent(String(id))})`;
}

/** A comment about to be sent: the body it carries and the targets it names. */
export interface IssueCommentSubmission {
  body: string;
  mentions: IssueMentionOption[];
}

/**
 * Read a composer draft as the comment it sends.
 *
 * The home composer writes a pick as a reference while editing and submits the
 * plain "@name" it stands for, so a comment stores the same text the home
 * does; the structured target travels beside it.
 */
export function issueCommentSubmission(value: string): IssueCommentSubmission {
  const seen = new Set<string>();
  const mentions: IssueMentionOption[] = [];
  let body = value;
  // Replace from the end so the earlier references keep their offsets.
  for (const reference of [...parseComposerReferences(value)].reverse()) {
    const scheme = MENTION_SCHEMES.find(([prefix]) =>
      reference.href.startsWith(prefix),
    );
    if (!scheme) continue;
    const [prefix, type] = scheme;
    // A reference may carry the scope the target belongs to before its id.
    const id = decodeURIComponent(
      reference.href.slice(prefix.length).split("/").filter(Boolean).at(-1) ??
        "",
    );
    if (!id) continue;
    const label = reference.label.replace(/^\$?@/, "") || id;
    body = `${body.slice(0, reference.start)}@${label}${body.slice(reference.end)}`;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({ type, id, label });
  }
  return { body: body.trim(), mentions };
}
