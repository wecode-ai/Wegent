// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  IssueHomeComposer,
  type IssueHomeTaskComposerProps,
} from "./IssueHomeComposer";
import { createCollaborationTranslator } from "../i18n";
import type { CollaborationMember } from "../types";
import { parseComposerMentions } from "../composer/composerMentions";

describe("Issue creation through the task composer port", () => {
  it("assigns only retained member references belonging to the selected project", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const onSubmit = vi.fn(async () => true);
    let port: IssueHomeTaskComposerProps | undefined;
    const members = [
      { user_id: 7, user_name: "李明" },
      { user_id: 8, user_name: "王芳" },
    ] as CollaborationMember[];
    try {
      await act(async () =>
        root.render(
          <IssueHomeComposer
            ref={createRef()}
            value=""
            onChange={vi.fn()}
            onSubmit={onSubmit}
            pending={false}
            members={members}
            agents={
              [
                { id: "agent-1", name: "研发助手", status: "active" },
              ] as import("../ports/SharedWorkspaceApi").WorkspaceProjectAgent[]
            }
            groups={
              [
                { id: "squad-1", name: "交付小队" },
              ] as import("../types").CollaborationGroup[]
            }
            projects={[]}
            projectId="project-1"
            onSelectProject={vi.fn()}
            translate={createCollaborationTranslator("zh-CN")}
            placeholder="描述工作"
            projectLabel="项目"
            memberLabel="成员"
            error={null}
            renderTaskComposer={(props) => {
              port = props;
              return props.ownerControl;
            }}
          />,
        ),
      );
      const reference = port!.members[0].reference!;
      expect(parseComposerMentions(reference)[0].label).toBe("@李明");
      await port!.onSubmit(`${reference} 请评审\n${reference} 并补充测试`);
      expect(onSubmit).toHaveBeenLastCalledWith(
        "@李明 请评审\n@李明 并补充测试",
        { kind: "user", id: "7" },
        [],
      );
      await port!.onSubmit("已删除引用，只保留工作说明");
      expect(onSubmit).toHaveBeenLastCalledWith(
        "已删除引用，只保留工作说明",
        null,
        [],
      );
      const callCount = onSubmit.mock.calls.length;
      await act(async () => {
        expect(
          await port!.onSubmit(
            "[$@李明](wework-member://another-project/7) 请评审",
          ),
        ).toBe(false);
      });
      expect(onSubmit).toHaveBeenCalledTimes(callCount);
      expect(port!.error).toContain("重新 @");
      const file = new File(["notes"], "notes.txt", { type: "text/plain" });
      await act(async () => port!.onFileSelect(file));
      await port!.onSubmit("请参考附件");
      expect(onSubmit).toHaveBeenLastCalledWith("请参考附件", null, [file]);
      const secondReference = port!.members[1].reference!;
      const draft = `${secondReference} 负责，${reference} 参与`;
      await act(async () => port!.onDraftChange!(draft));
      const owner = container.querySelector<HTMLButtonElement>(
        '[data-testid="collaboration-issue-owner"]',
      )!;
      expect(owner.textContent).toBe("王芳");
      expect(container.querySelector("select")).toBeNull();
      await port!.onSubmit(draft);
      expect(onSubmit).toHaveBeenLastCalledWith(
        "@王芳 负责，@李明 参与",
        { kind: "user", id: "8" },
        [file],
      );
      await act(async () => owner.click());
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="collaboration-issue-owner-7"]',
          )!
          .click(),
      );
      await act(async () => port!.onDraftChange!(draft));
      expect(owner.textContent).toBe("李明");
      await port!.onSubmit(draft);
      expect(onSubmit).toHaveBeenLastCalledWith(
        "@王芳 负责，@李明 参与",
        { kind: "user", id: "7" },
        [file],
      );
      await act(async () => owner.click());
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="collaboration-issue-owner-none"]',
          )!
          .click(),
      );
      expect(owner.textContent).toBe("");
      await port!.onSubmit(draft);
      expect(onSubmit).toHaveBeenLastCalledWith(
        "@王芳 负责，@李明 参与",
        null,
        [file],
      );
      for (const [kind, id, title] of [
        ["agent", "agent-1", "研发助手"],
        ["group", "squad-1", "交付小队"],
      ] as const) {
        const candidate = port!.members.find((item) => item.type === kind)!;
        expect(parseComposerMentions(candidate.reference!)[0].label).toBe(
          `@${title}`,
        );
        await act(async () => owner.click());
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              `[data-testid="collaboration-issue-owner-${kind}:${id}"]`,
            )!
            .click(),
        );
        expect(owner.textContent).toBe(title);
        await port!.onSubmit(`${candidate.reference} 请处理`);
        expect(onSubmit).toHaveBeenLastCalledWith(
          `@${title} 请处理`,
          { kind, id },
          [file],
        );
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});
