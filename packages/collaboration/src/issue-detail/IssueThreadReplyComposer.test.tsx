// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueThreadReplyComposer,
  type IssueReplyAttachments,
} from "./IssueThreadReplyComposer";
import {
  issueCommentBody,
  useIssueCommentAttachments,
} from "./useIssueCommentAttachments";
import type { CollaborationAttachment } from "../types";

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

describe("shared desktop reply composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  function write(value: string) {
    const input = container.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }
  const sendButton = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-task-activity-card-send-root"]',
    )!;

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
    act(() =>
      root.render(
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          attachments={selection}
          onSend={send}
        />,
      ),
    );
    const input = write("Keep this draft");
    await act(async () => sendButton().click());
    expect(input.value).toBe("Keep this draft");
    expect(resetAttachments).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "offline",
    );
    await act(async () => sendButton().click());
    expect(input.value).toBe("");
    expect(resetAttachments).toHaveBeenCalledOnce();
  });

  it("does not submit an IME confirmation or Shift+Enter and prevents duplicate submissions", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const send = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    act(() =>
      root.render(
        <IssueThreadReplyComposer
          rootId="root"
          disabled={false}
          labels={labels}
          onSend={send}
        />,
      ),
    );
    const input = write("输入法");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(send).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(send).toHaveBeenCalledOnce();
    expect(input.disabled).toBe(true);
    await act(async () => finish({ ok: true }));
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("");
  });

  it("keeps pasted uploads out of the draft, gates sending, and submits attachment Markdown", async () => {
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
          attachments={selection}
          onSend={(text) => send(issueCommentBody(text, selection.attachments))}
        />
      );
    }
    act(() => root.render(<Harness />));
    const input = write("Review this");
    act(() => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { files: [file] },
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(upload).toHaveBeenCalledWith(file);
    expect(input.value).toBe("Review this");
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
          attachments={selection}
          onSend={vi.fn()}
        />
      );
    }
    act(() => root.render(<Harness />));
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
});
