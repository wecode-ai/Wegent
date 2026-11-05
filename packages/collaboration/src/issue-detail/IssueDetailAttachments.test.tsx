// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueDetailAttachments,
  type IssueDetailAttachmentsProps,
} from "./IssueDetailCore";

describe("IssueDetailAttachments", () => {
  let container: HTMLDivElement;
  let root: Root;
  const createObjectURL = vi.fn(() => "blob:attachment-preview");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal(
      "URL",
      Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }),
    );
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderAttachments(
    overrides: Partial<IssueDetailAttachmentsProps> = {},
  ) {
    const props: IssueDetailAttachmentsProps = {
      attachments: [
        {
          id: "image-1",
          displayName: "design.png",
          contentType: "image/png",
          sizeBytes: 100,
        },
      ],
      compact: true,
      busy: false,
      error: null,
      editable: true,
      labels: {
        title: "附件",
        upload: "上传",
        uploading: "上传中…",
        empty: "暂无附件",
        dropzone: "点击上传或拖拽文件到这里",
        downloading: "下载中…",
        expand: (count) => `查看全部 ${count} 个`,
        collapse: "收起",
        download: (name) => `下载 ${name}`,
        remove: (name) => `删除 ${name}`,
      },
      testIdPrefix: "attachments",
      onAdd: vi.fn(async () => undefined),
      onRemove: vi.fn(async () => undefined),
      onOpen: vi.fn(async () => undefined),
      loadPreview: vi.fn(
        async () => new Blob(["image"], { type: "image/png" }),
      ),
      ...overrides,
    };
    await act(async () => root.render(<IssueDetailAttachments {...props} />));
    return props;
  }

  function toggle() {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="attachments-toggle"]',
    )!;
  }

  it("loads previews only after expansion and releases them on collapse", async () => {
    const props = await renderAttachments({ totalCount: 3 });
    expect(toggle().textContent).toBe("附件3");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(
      toggle().getAttribute("aria-controls")!,
    )!;
    expect(body.hidden).toBe(true);
    expect(container.querySelector("img")).toBeNull();
    expect(props.loadPreview).not.toHaveBeenCalled();

    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    expect(props.loadPreview).toHaveBeenCalledExactlyOnceWith("image-1");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:attachment-preview",
    );
    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="attachments-open-image-1"]',
    )!;
    await act(async () => open.click());
    expect(props.onOpen).toHaveBeenCalledWith(props.attachments[0]);

    await act(async () => toggle().click());
    expect(body.hidden).toBe(true);
    expect(container.querySelector("img")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment-preview");
    expect(props.loadPreview).toHaveBeenCalledTimes(1);
  });

  it("keeps upload and errors available while collapsed and handles a drop only once", async () => {
    const props = await renderAttachments({ error: "上传失败" });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "上传失败",
    );
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="attachments-input"]',
    )!;
    const files = [new File(["notes"], "notes.txt")] as unknown as FileList;
    Object.defineProperty(input, "files", { value: files });
    await act(async () =>
      input.dispatchEvent(new Event("change", { bubbles: true })),
    );
    expect(props.onAdd).toHaveBeenCalledExactlyOnceWith(files);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    const parentDrop = vi.fn();
    document.body.addEventListener("drop", parentDrop);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files } });
    await act(async () => toggle().dispatchEvent(drop));
    expect(props.onAdd).toHaveBeenCalledTimes(2);
    expect(parentDrop).not.toHaveBeenCalled();
    document.body.removeEventListener("drop", parentDrop);

    await renderAttachments({ busy: true });
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="attachments-input"]',
      )?.disabled,
    ).toBe(true);
  });

  it("allows read-only expansion without upload or delete controls", async () => {
    const props = await renderAttachments({ editable: false });
    expect(container.querySelector("input")).toBeNull();
    await act(async () => toggle().click());
    expect(
      container.querySelector('[data-testid="attachments-open-image-1"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="attachments-delete-image-1"]'),
    ).toBeNull();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [] } });
    await act(async () => toggle().dispatchEvent(drop));
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it("keeps the noncompact creation form expanded", async () => {
    await renderAttachments({ compact: false, attachments: [] });
    expect(toggle()).toBeNull();
    expect(container.textContent).toContain("暂无附件");
    expect(
      container.querySelector('[data-testid="attachments-input"]'),
    ).not.toBeNull();
  });
});
