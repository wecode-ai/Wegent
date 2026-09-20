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
