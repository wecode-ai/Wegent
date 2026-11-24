// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IssueActivityMarkdown } from "./IssueActivityMarkdown";
import { IssueMarkdownProvider } from "./IssueMarkdownProvider";
import { MarkdownServicesProvider, browserMarkdownServices } from "../markdown";
import { createCollaborationTranslator } from "../i18n";
import type { SharedWorkspaceAttachmentsApi } from "../ports/SharedWorkspaceApi";

let root: Root;
let container: HTMLDivElement;
const translate = createCollaborationTranslator("zh-CN");
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses the desktop code, table, heading and numbered-list renderers in Web activity", async () => {
  const copyText = vi.fn().mockResolvedValue(undefined);
  const table = "| A | B |\n| --- | --- |\n| **One** | Two |";
  await act(async () =>
    root.render(
      <MarkdownServicesProvider
        value={{ ...browserMarkdownServices, copyText }}
      >
        <IssueActivityMarkdown
          translate={translate}
          content={`# Title\n\n3. Third\n4. Fourth\n\n\`\`\`ts\nconst value = 1\n\`\`\`\n\n${table}`}
        />
      </MarkdownServicesProvider>,
    ),
  );
  expect(container.querySelector("h1")?.classList.contains("text-lg")).toBe(
    true,
  );
  expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
  expect(
    container.querySelector('[data-testid="markdown-code-block"]')?.textContent,
  ).toContain("const value = 1");
  const expand = container.querySelector<HTMLButtonElement>(
    '[data-testid="markdown-table-expand-button"]',
  )!;
  await act(async () => expand.click());
  const dialog = document.querySelector(
    '[data-testid="markdown-table-dialog"]',
  )!;
  expect(dialog.querySelector("strong")?.textContent).toBe("One");
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(
    document.querySelector('[data-testid="markdown-table-dialog"]'),
  ).toBeNull();
  expect(document.activeElement).toBe(expand);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="markdown-table-copy-button"]',
      )!
      .click(),
  );
  expect(copyText).toHaveBeenCalledExactlyOnceWith(table);
});

it("shares syntax theme styles across code blocks and content remounts", async () => {
  const content = [
    "~~~ts",
    "const one = 1",
    "~~~",
    "",
    "~~~ts",
    "const two = 2",
    "~~~",
  ].join("\n");
  const stylesheet = 'style[data-href="wegent-markdown-code-theme"]';
  await act(async () => root.render(<IssueActivityMarkdown content={content} />));
  expect(container.querySelectorAll('[data-testid="markdown-code-block"]')).toHaveLength(2);
  expect(container.querySelector("style")).toBeNull();
  expect(document.head.querySelectorAll(stylesheet)).toHaveLength(1);
  const theme = document.head.querySelector(stylesheet);
  expect(theme?.textContent).toContain("--hls-foreground");

  await act(async () => root.render(<IssueActivityMarkdown content="Done" />));
  await act(async () => root.render(<IssueActivityMarkdown content={content} />));
  expect(document.head.querySelectorAll(stylesheet)).toHaveLength(1);
  expect(document.head.querySelector(stylesheet)).toBe(theme);
});

it("loads authenticated Web images with the attachment service and releases replaced previews", async () => {
  const read = vi
    .fn()
    .mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  const createObjectURL = vi.fn().mockReturnValue("blob:authenticated-preview");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  const attachments = { read } as unknown as SharedWorkspaceAttachmentsApi;
  await act(async () =>
    root.render(
      <IssueMarkdownProvider attachments={attachments}>
        <IssueActivityMarkdown content="![preview](/api/attachments/42/download)" />
      </IssueMarkdownProvider>,
    ),
  );
  expect(read).toHaveBeenCalledWith("42");
  expect(container.querySelector("img")?.src).toBe(
    "blob:authenticated-preview",
  );
  await act(async () => root.render(<IssueActivityMarkdown content="Done" />));
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:authenticated-preview");
});

it("keeps cloud attachment actions and safe external navigation on the same renderer", async () => {
  const onOpenAttachment = vi.fn();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () =>
    root.render(
      <IssueActivityMarkdown
        content="[Report](wegent://attachments/file-1) [Docs](https://example.com/docs) [Source](/tmp/source.ts)"
        onOpenAttachment={onOpenAttachment}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="issue-comment-attachment-file-1"]',
      )!
      .click(),
  );
  expect(
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="/tmp/source.ts"]',
    )?.disabled,
  ).toBe(true);
  expect(onOpenAttachment).toHaveBeenCalledExactlyOnceWith("file-1", "Report");
  await act(async () =>
    container.querySelector<HTMLAnchorElement>("a")!.click(),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/docs",
    "_blank",
    "noopener,noreferrer",
  );
});

it("allows long recognized-link labels to wrap inside Issue comments", async () => {
  const url = `https://github.com/example/repository/commit/${"a".repeat(80)}`;
  const label = `commit ${"a".repeat(120)}`;
  await act(async () =>
    root.render(<IssueActivityMarkdown content={`[${label}](${url})`} />),
  );

  const link = container.querySelector<HTMLAnchorElement>(
    '[data-testid="composer-link-chip"]',
  )!;
  const linkLabel = link.querySelector<HTMLSpanElement>(
    ".composer-mention-label",
  )!;
  expect(link.classList.contains("composer-link-node")).toBe(true);
  expect(linkLabel.classList.contains("min-w-0")).toBe(true);
  expect(linkLabel.classList.contains("whitespace-normal")).toBe(true);
  expect(linkLabel.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
});

it("opens the current Issue attachment by its exact link label instead of its executor path", async () => {
  const onOpenAttachment = vi.fn();
  const list = vi
    .fn()
    .mockResolvedValue([
      { id: "uploaded-report", display_name: "需求澄清.md" },
    ]);
  const attachments = { list } as unknown as SharedWorkspaceAttachmentsApi;
  await act(async () =>
    root.render(
      <IssueMarkdownProvider attachments={attachments} issueId="issue-6">
        <IssueActivityMarkdown
          content="[需求澄清.md](/home/ubuntu/executor/outputs/clarification.md)"
          onOpenAttachment={onOpenAttachment}
        />
      </IssueMarkdownProvider>,
    ),
  );
  expect(list).not.toHaveBeenCalled();
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="issue-comment-file-attachment"]',
  )!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(list).toHaveBeenCalledExactlyOnceWith("issue-6");
  expect(onOpenAttachment).toHaveBeenCalledExactlyOnceWith(
    "uploaded-report",
    "需求澄清.md",
  );
});

it("resolves against the new Issue after navigation and leaves external links alone", async () => {
  const onOpenAttachment = vi.fn();
  const list = vi.fn(async (issueId: string) => [
    { id: issueId, display_name: "report.md" },
  ]);
  const attachments = { list } as unknown as SharedWorkspaceAttachmentsApi;
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  for (const issueId of ["first-issue", "second-issue"]) {
    await act(async () =>
      root.render(
        <IssueMarkdownProvider attachments={attachments} issueId={issueId}>
          <IssueActivityMarkdown
            content="[report.md](/remote/report.md) [report.md](https://example.com/report.md)"
            onOpenAttachment={onOpenAttachment}
          />
        </IssueMarkdownProvider>,
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="issue-comment-file-attachment"]',
        )!
        .click(),
    );
    expect(list).toHaveBeenLastCalledWith(issueId);
    expect(onOpenAttachment).toHaveBeenLastCalledWith(issueId, "report.md");
  }
  await act(async () =>
    container.querySelector<HTMLAnchorElement>("a")!.click(),
  );
  expect(list).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/report.md",
    "_blank",
    "noopener,noreferrer",
  );
});

it.each(["missing", "ambiguous", "offline", "open-failed"])(
  "reports %s attachments and permits recovery without guessing a file",
  async (failure) => {
    const onOpenAttachment = vi.fn();
    const list = vi.fn().mockResolvedValue(
      failure === "missing"
        ? [{ id: "other", display_name: "prefix-report.md" }]
        : failure === "ambiguous"
          ? [
              { id: "first", display_name: "report.md" },
              { id: "second", display_name: "report.md" },
            ]
          : [{ id: "report", display_name: "report.md" }],
    );
    if (failure === "offline") list.mockRejectedValueOnce(new Error("offline"));
    if (failure === "open-failed")
      onOpenAttachment.mockRejectedValueOnce(new Error("read failed"));
    const attachments = { list } as unknown as SharedWorkspaceAttachmentsApi;
    await act(async () =>
      root.render(
        <IssueMarkdownProvider attachments={attachments} issueId="issue-6">
          <IssueActivityMarkdown
            content="[report.md](/remote/report.md)"
            translate={translate}
            onOpenAttachment={onOpenAttachment}
          />
        </IssueMarkdownProvider>,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="issue-comment-file-attachment"]',
    )!;
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      translate("todo.file_preview_failed"),
    );
    if (failure !== "open-failed")
      expect(onOpenAttachment).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    list.mockResolvedValue([{ id: "recovered", display_name: "report.md" }]);
    await act(async () => button.click());
    expect(onOpenAttachment).toHaveBeenLastCalledWith("recovered", "report.md");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);
