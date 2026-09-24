import { describe, expect, it } from "vitest";
import {
  issueCommentSubmission,
  issueMentionCandidates,
} from "./issueCommentMentions";

describe("issueMentionCandidates", () => {
  it("offers members and robots as the references the home composer writes", () => {
    expect(
      issueMentionCandidates({
        members: [{ user_id: 8, user_name: "bob" }],
        agents: [{ id: "12", name: "Code Reviewer" }],
        membersLabel: "成员",
        agentsLabel: "机器人",
      }),
    ).toEqual([
      expect.objectContaining({
        id: "8",
        type: "user",
        title: "bob",
        metaLabel: "成员",
        reference: "[$@bob](wework-member://8)",
        testId: "collaboration-issue-mention-member-8",
      }),
      expect.objectContaining({
        id: "12",
        type: "agent",
        title: "Code Reviewer",
        metaLabel: "机器人",
        reference: "[$@Code Reviewer](wework-agent://12)",
        testId: "collaboration-issue-mention-agent-12",
      }),
    ]);
  });
});

describe("issueCommentSubmission", () => {
  it("submits a pick as the plain mention the home composer submits", () => {
    expect(
      issueCommentSubmission("[$@bob](wework-member://8) please review"),
    ).toEqual({
      body: "@bob please review",
      mentions: [{ type: "user", id: "8", label: "bob" }],
    });
  });

  it("reads a robot pick as an agent target", () => {
    expect(
      issueCommentSubmission("[$@Code Reviewer](wework-agent://12) 看下"),
    ).toEqual({
      body: "@Code Reviewer 看下",
      mentions: [{ type: "agent", id: "12", label: "Code Reviewer" }],
    });
  });

  it("reads the id from a reference that carries its scope", () => {
    expect(
      issueCommentSubmission("[$@李明](wework-member://p1/7) 请评审"),
    ).toEqual({
      body: "@李明 请评审",
      mentions: [{ type: "user", id: "7", label: "李明" }],
    });
  });

  it("counts one member once however often the draft names them", () => {
    expect(
      issueCommentSubmission(
        "[$@bob](wework-member://8) 和 [$@bob](wework-member://8)",
      ),
    ).toEqual({
      body: "@bob 和 @bob",
      mentions: [{ type: "user", id: "8", label: "bob" }],
    });
  });

  it("leaves other references in the body and sends no target for them", () => {
    expect(
      issueCommentSubmission("[$README.md](file:///repo/README.md) 已更新"),
    ).toEqual({
      body: "[$README.md](file:///repo/README.md) 已更新",
      mentions: [],
    });
  });

  it("sends no target once the draft dropped the mention", () => {
    expect(issueCommentSubmission("please review")).toEqual({
      body: "please review",
      mentions: [],
    });
  });
});
