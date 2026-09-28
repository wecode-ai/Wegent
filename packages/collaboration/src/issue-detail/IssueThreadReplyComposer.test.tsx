// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerInputHandle } from "../composer/composerInputTypes";
import { createCollaborationTranslator } from "../i18n";
import { issueMentionCandidates } from "./issueCommentMentions";
import {
  IssueThreadReplyComposer,
  type IssueReplyAttachments,
} from "./IssueThreadReplyComposer";
import {
  issueCommentBody,
  useIssueCommentAttachments,
} from "./useIssueCommentAttachments";
import type { CollaborationAttachment } from "../types";

const translate = createCollaborationTranslator("zh-CN");
const labels = {
  placeholder: "Reply…",
  send: "Send message",
  attach: "Attach files",
  removeAttachment: "Remove attachment",
  uploading: "Uploading",
  sendFailed: "Failed",
};
const file = new File(["content"], "report.txt", { type: "text/plain" });
const attachment = {
  id: "a1",
  display_name: "report.txt",
  markdown: "[report.txt](wegent://attachments/a1)",
} as CollaborationAttachment;

/** The members a comment can mention, as the composers hand them to the menu. */
const mentionCandidates = issueMentionCandidates({
  members: [
    { user_id: 8, user_name: "bob" },
    { user_id: 7, user_name: "alice" },
  ],
  agents: [],
  membersLabel: "Members",
  agentsLabel: "Agents",
});

describe("shared desktop reply composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  const input = createRef<ComposerInputHandle>();
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no text-range geometry; ProseMirror reads it when restoring selection.
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const element = (id: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const editor = () => element("cloud-task-activity-card-composer-root");
  const sendButton = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-task-activity-card-send-root"]',
    )!;
  async function mount(
    props: Partial<{ attachments: IssueReplyAttachments }> = {},
  ) {
    await act(async () =>
      root.render(
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          translate={translate}
          inputRef={input}
          mentionCandidates={mentionCandidates}
          onSend={vi.fn().mockResolvedValue({ ok: true })}
          {...props}
        />,
      ),
    );
  }
  async function write(value: string) {
    await act(async () => {
      input.current!.setValue(value);
      input.current!.focus();
      editor().dispatchEvent(
        new KeyboardEvent("keyup", { key: value.at(-1) ?? "", bubbles: true }),
      );
    });
  }

  it("retains draft and attachments on rejection and clears them only after a successful retry", async () => {
    const resetAttachments = vi.fn();
    const selection: IssueReplyAttachments = {
      attachments: [{ id: "a1", filename: "report.txt" }],
      uploadingFiles: new Map(),
      errors: new Map(),
      isAttachmentReadyToSend: true,
      handleFileSelect: vi.fn(),
      removeAttachment: vi.fn(),
      resetAttachments,
    };
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true });
    await mount({ attachments: selection });
    await act(async () =>
      root.render(
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          translate={translate}
          inputRef={input}
          mentionCandidates={mentionCandidates}
          attachments={selection}
          onSend={send}
        />,
      ),
    );
    await write("first attempt");
    await act(async () => sendButton().click());
    expect(send).toHaveBeenCalledWith("first attempt", []);
    expect(input.current!.getValue()).toBe("first attempt");
    expect(resetAttachments).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "offline",
    );

    await act(async () => sendButton().click());
    expect(send).toHaveBeenCalledTimes(2);
    expect(input.current!.getValue()).toBe("");
    expect(resetAttachments).toHaveBeenCalledOnce();
  });

  it("gates sending on an upload and submits the attachment Markdown", async () => {
    let finish!: (value: CollaborationAttachment) => void;
    const upload = vi.fn(
      () =>
        new Promise<CollaborationAttachment>((resolve) => {
          finish = resolve;
        }),
    );
    const send = vi.fn().mockResolvedValue({ ok: true });
    function Harness() {
      const selection = useIssueCommentAttachments(upload, vi.fn());
      return (
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          translate={translate}
          inputRef={input}
          mentionCandidates={mentionCandidates}
          attachments={selection}
          onSend={(text) => send(issueCommentBody(text, selection.attachments))}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    await write("Review this");
    const picker =
      container.querySelector<HTMLInputElement>("input[type=file]")!;
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [file] });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sendButton().disabled).toBe(true);
    await act(async () => finish(attachment));
    expect(container.textContent).toContain("report.txt");
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(send).toHaveBeenCalledWith(
      "Review this\n\n[report.txt](wegent://attachments/a1)",
    );
    expect(container.textContent).not.toContain("report.txt");
  });

  it("keeps an attachment when storage deletion fails and permits retry", async () => {
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce(undefined);
    function Harness() {
      const selection = useIssueCommentAttachments(
        async () => attachment,
        remove,
      );
      return (
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          translate={translate}
          inputRef={input}
          mentionCandidates={mentionCandidates}
          attachments={selection}
          onSend={vi.fn()}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    const picker =
      container.querySelector<HTMLInputElement>("input[type=file]")!;
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [file] });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const removeButton = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove attachment"]',
      )!;
    await act(async () => removeButton().click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "delete failed",
    );
    expect(removeButton()).not.toBeNull();
    await act(async () => removeButton().click());
    expect(removeButton()).toBeNull();
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("writes a picked member as a reference and sends its plain text and target", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await mount({ attachments: undefined });
    await act(async () =>
      root.render(
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          translate={translate}
          inputRef={input}
          mentionCandidates={mentionCandidates}
          onSend={send}
        />,
      ),
    );
    await act(async () => input.current!.insertReference("@"));
    await act(async () =>
      element("collaboration-issue-mention-member-8").click(),
    );
    expect(input.current!.getValue()).toBe("[$@bob](wework-member://8) ");

    await write("[$@bob](wework-member://8) please review");
    await act(async () => sendButton().click());

    expect(send).toHaveBeenCalledWith("@bob please review", [
      { type: "user", id: "8", label: "bob" },
    ]);
  });

  it("sends no mention once the reference is gone from the draft", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await act(async () =>
      root.render(
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          translate={translate}
          inputRef={input}
          mentionCandidates={mentionCandidates}
          onSend={send}
        />,
      ),
    );
    await act(async () => input.current!.insertReference("@"));
    await act(async () =>
      element("collaboration-issue-mention-member-8").click(),
    );
    await write("hello there");
    await act(async () => sendButton().click());

    expect(send).toHaveBeenCalledWith("hello there", []);
  });
});
