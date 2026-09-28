// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import type { SharedWorkspaceAttachmentsApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationAttachment } from "../types";
import { IssueWebCommentComposer } from "./IssueWebCommentComposer";

describe("Web adapter for the desktop main composer", () => {
  let root: Root;
  let container: HTMLDivElement;
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
    vi.stubGlobal("IntersectionObserver", undefined);
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const editor = () =>
    container.querySelector<HTMLElement & { value: string }>(
      '[data-testid="collaboration-issue-comment"]',
    )!;
  async function render(
    upload: SharedWorkspaceAttachmentsApi["upload"],
    send = vi.fn().mockResolvedValue(undefined),
  ) {
    const api = {
      upload,
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharedWorkspaceAttachmentsApi;
    await act(async () =>
      root.render(
        <IssueWebCommentComposer
          issueId="issue"
          canComment
          canAttach
          loading={false}
          members={[]}
          agents={[]}
          attachmentApi={api}
          translate={createCollaborationTranslator("zh-CN")}
          send={send}
          onSent={vi.fn()}
          onError={vi.fn()}
          settings={
            <span data-testid="comment-execution-settings">
              Comment execution settings
            </span>
          }
        />,
      ),
    );
    return { send };
  }
  function write(text: string) {
    const input = editor();
    act(() => {
      input.value = text;
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: text.at(-1) ?? "", bubbles: true }),
      );
    });
    return input;
  }
  async function select(file: File) {
    await act(async () => {
      const picker =
        container.querySelector<HTMLInputElement>("input[type=file]")!;
      Object.defineProperty(picker, "files", {
        value: [file],
        configurable: true,
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("uses the desktop controls and keeps a selected document and draft on send failure", async () => {
    const attachment = {
      id: "a1",
      display_name: "brief.pdf",
      content_type: "application/pdf",
      markdown: "[brief.pdf](wegent://attachments/a1)",
    } as CollaborationAttachment;
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    await render(vi.fn().mockResolvedValue(attachment), send);
    expect(
      container.querySelector(".composer-prosemirror-placeholder")?.textContent,
    ).toBe("留下评论…");
    expect(
      container.querySelectorAll(".task-detail-new-comment-actions button"),
    ).toHaveLength(3);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="collaboration-comment-settings-toggle"]',
        )!
        .click(),
    );
    expect(
      container.querySelector(".task-detail-comment-settings")?.textContent,
    ).toBe("Comment execution settings");
    await select(new File(["pdf"], "brief.pdf", { type: "application/pdf" }));
    expect(
      container.querySelector("[data-testid=attachment-badge]")?.className,
    ).toContain("w-40");
    expect(
      container.querySelector("[data-testid=attachment-document-icon] svg"),
    ).not.toBeNull();
    await write("Review this");
    const input = editor();
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="collaboration-issue-comment-submit"]',
    )!;
    await act(async () => submit.click());
    expect(input.value).toBe("Review this");
    expect(
      container.querySelector("[data-testid=attachment-badge]"),
    ).not.toBeNull();
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "offline",
    );
    await act(async () => submit.click());
    expect(send).toHaveBeenLastCalledWith(
      "Review this\n\n[brief.pdf](wegent://attachments/a1)",
    );
    expect(input.value).toBe("");
    expect(
      container.querySelector("[data-testid=attachment-badge]"),
    ).toBeNull();
  });

  it("opens the shared image lightbox, zooms and releases the preview when its attachment is removed", async () => {
    const attachment = {
      id: "image",
      display_name: "screen.png",
      content_type: "image/png",
    } as CollaborationAttachment;
    await render(vi.fn().mockResolvedValue(attachment));
    await select(new File(["image"], "screen.png", { type: "image/png" }));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid=attachment-image-preview-button]",
        )!
        .click(),
    );
    expect(
      document.querySelector("[data-testid=attachment-image-lightbox]"),
    ).not.toBeNull();
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          "[data-testid=attachment-image-zoom-in]",
        )!
        .click(),
    );
    expect(
      document.querySelector("[data-testid=attachment-image-zoom-value]")
        ?.textContent,
    ).toBe("125%");
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(
      document.querySelector("[data-testid=attachment-image-lightbox]"),
    ).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid=remove-attachment-button]",
        )!
        .click(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    expect(
      container.querySelector("[data-testid=attachment-badge]"),
    ).toBeNull();
  });
});
