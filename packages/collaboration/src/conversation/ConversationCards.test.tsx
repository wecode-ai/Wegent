// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { WindowedMarkdownChunk } from "../markdown/WindowedMarkdownChunk";
import {
  createMarkdownWindowingScope,
  MarkdownWindowingContext,
} from "../markdown/MarkdownWindowingScope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnFileChangesSummary } from "@wegent/chat-core/runtime";
import { createCollaborationTranslator } from "../i18n";
import { CollaborationTheme } from "../theme";
import { ConversationTranslationProvider } from "./ConversationTranslation";
import { FileChangesCard } from "./FileChangesCard";
import { RequestUserInputCard } from "./RequestUserInputCard";
import { CodexReferenceList } from "./CodexTurnArtifacts";
import { getAssistantReferences } from "./codexReferences";
import { createMessageTextSelectionState } from "./messageTextSelectionState";
import { selectedShareExcerpts } from "../platform/selectedShareExcerpts";
import { TaskIssueShareExcerpts } from "../platform/TaskIssueShareExcerpts";
import { SelectionActionsPopover } from "./SelectionActionsPopover";
import { AssistantErrorCard } from "./AssistantErrorCard";
import { GitAccountConfigurationProvider } from "../controls/GitAccountConfiguration";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function element(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!target) throw new Error(`Missing control ${id}`);
  return target;
}
function render(children: ReactNode, locale: "en" | "zh-CN" = "en") {
  act(() =>
    root.render(
      <CollaborationTheme mode="dark">
        <ConversationTranslationProvider
          translate={createCollaborationTranslator(locale)}
        >
          {children}
        </ConversationTranslationProvider>
      </CollaborationTheme>,
    ),
  );
}
const summary: TurnFileChangesSummary = {
  version: 1,
  status: "active",
  artifact_id: "artifact-1",
  device_id: "device-1",
  workspace_path: "/workspace",
  file_count: 1,
  additions: 1,
  deletions: 0,
  files: [
    {
      path: "hello.ts",
      change_type: "created",
      additions: 1,
      deletions: 0,
      binary: false,
    },
  ],
};

describe("shared conversation cards without Electron", () => {
  it("opens the correct Git account from the error card and preserves retry", async () => {
    const openUrl = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "git-error",
      role: "assistant",
      content: "",
    } as Parameters<typeof AssistantErrorCard>[0]["message"];
    render(
      <GitAccountConfigurationProvider
        value={{ baseUrl: "https://cloud.example", openUrl }}
      >
        <AssistantErrorCard
          error='git-access:{"code":"authentication-failed","domain":"git.example:8443","message":"Authentication rejected"}'
          message={message}
          onRetry={retry}
          onSwitchModel={vi.fn()}
        />
      </GitAccountConfigurationProvider>,
    );
    await act(async () => element("assistant-error-configure-git").click());
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      "https://cloud.example/settings?tab=integrations&gitDomain=git.example%3A8443#git-accounts",
    );
    expect(element("assistant-error-configure-git").textContent).toContain(
      "Configure Git accounts",
    );
    act(() => element("assistant-error-retry").click());
    expect(retry).toHaveBeenCalledWith(message);
    expect(
      container.querySelector(
        '[data-testid="assistant-error-switch-model-retry"]',
      ),
    ).toBeNull();
  });

  it("shows checkout configuration guidance without raw JSON or a model-switch action", () => {
    const retry = vi.fn();
    const message = {
      id: "turn-git",
      type: "assistant",
      content: "",
    } as Parameters<typeof AssistantErrorCard>[0]["message"];
    render(
      <AssistantErrorCard
        error={
          'git-access:{"code":"credentials-required","domain":"git.example:8443","message":"Configure Git"}'
        }
        errorType="container_error"
        message={message}
        onRetry={retry}
        onSwitchModel={vi.fn()}
      />,
    );
    expect(element("assistant-error-title").textContent).toBe(
      "Git repository access failed",
    );
    expect(element("assistant-error-description").textContent).toContain(
      "git.example:8443",
    );
    expect(element("assistant-error-description").textContent).toContain(
      "Settings → Integrations → Git accounts",
    );
    expect(
      document.querySelector('[data-testid="assistant-error-details"]'),
    ).toBeNull();
    act(() => element("assistant-error-details-toggle").click());
    expect(element("assistant-error-details").textContent).not.toContain(
      "git-access:",
    );
    expect(
      document.querySelector(
        '[data-testid="assistant-error-switch-model-retry"]',
      ),
    ).toBeNull();
    act(() => element("assistant-error-retry").click());
    expect(retry).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    [
      "server_overloaded",
      "connection interrupted",
      "Model service is busy",
      "overloaded",
    ],
    [
      "timeout_error",
      "codex app-server turn made no model or tool progress for 180s; the shared app-server was restarted",
      "Timed out waiting for a response",
      "within 180 seconds",
    ],
    [
      "llm_error",
      "No tool output found for tool call call_1.",
      "The model could not process the conversation history",
      "The new conversation will reference this one",
    ],
  ])(
    "shows localized terminal %s separately from diagnostics",
    (type, error, title, guidance) => {
      const continueInNewConversation = vi.fn();
      render(
        <AssistantErrorCard
          error={error}
          errorType={type}
          onContinueInNewConversation={continueInNewConversation}
          onRetry={vi.fn()}
          onSwitchModel={vi.fn()}
          message={{
            id: "failed",
            role: "assistant",
            content: "",
            status: "failed",
            createdAt: "2026-11-17T09:00:00Z",
          }}
        />,
      );
      expect(element("assistant-error-title").textContent).toBe(title);
      const retry = element("assistant-error-retry");
      const switchModel = element("assistant-error-switch-model-retry");
      expect(retry.textContent).toBe("Retry");
      const recovery = container.querySelector<HTMLButtonElement>(
        '[data-testid="assistant-error-continue-in-new-conversation"]',
      );
      if (type === "llm_error") {
        if (!recovery) throw new Error("Missing new conversation action");
        expect(recovery.textContent).toBe("Continue in a new conversation");
        expect(retry.compareDocumentPosition(switchModel)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(switchModel.compareDocumentPosition(recovery)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
        act(() => recovery.click());
        expect(continueInNewConversation).toHaveBeenCalledOnce();
      } else {
        expect(recovery).toBeNull();
        expect(switchModel.compareDocumentPosition(retry)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }
      expect(
        document.querySelector('[data-testid="assistant-error-details"]'),
      ).toBeNull();
      expect(element("assistant-error-description").textContent).toContain(
        guidance,
      );
      act(() => element("assistant-error-details-toggle").click());
      expect(element("assistant-error-details").textContent).toBe(error);
    },
  );

  it.each([
    ["en", "Timed out waiting for a response", "within 180 seconds"],
    ["zh-CN", "等待响应超时", "180 秒内未收到模型或工具进展"],
  ] as const)(
    "keeps watchdog diagnostics behind details in %s",
    (locale, title, description) => {
      const error =
        "codex app-server turn made no model or tool progress for 180s; the shared app-server was restarted";
      render(
        <AssistantErrorCard
          error={error}
          message={{
            id: "watchdog",
            role: "assistant",
            content: "",
            status: "failed",
          }}
        />,
        locale,
      );
      expect(element("assistant-error-title").textContent).toBe(title);
      expect(element("assistant-error-description").textContent).toContain(
        description,
      );
      expect(container.textContent).not.toContain("app-server");
      expect(
        element("assistant-error-details-toggle").getAttribute("aria-expanded"),
      ).toBe("false");
      act(() => element("assistant-error-details-toggle").click());
      expect(element("assistant-error-details").textContent).toBe(error);
      act(() => element("assistant-error-details-toggle").click());
      expect(
        container.querySelector('[data-testid="assistant-error-details"]'),
      ).toBeNull();
    },
  );

  it("keeps revert confirmation themed and calls the host only after confirmation", async () => {
    const revert = vi
      .fn()
      .mockResolvedValue({ ...summary, status: "reverted" });
    render(
      <FileChangesCard
        subtaskId="turn-1"
        summary={summary}
        deviceOnline
        onLoadDiff={vi.fn()}
        onRevert={revert}
      />,
    );
    expect(element("file-changes-card").textContent).toContain(
      "Created hello.ts",
    );
    act(() => element("revert-file-changes-button").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(container.contains(dialog)).toBe(false);
    expect(
      dialog.closest<HTMLElement>(".collaboration-theme")?.dataset.theme,
    ).toBe("dark");
    expect(revert).not.toHaveBeenCalled();
    await act(async () =>
      element("confirm-revert-file-changes-button").click(),
    );
    expect(revert).toHaveBeenCalledExactlyOnceWith("turn-1", summary);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("preserves runtime request identity and selected answers", async () => {
    const submit = vi.fn().mockResolvedValue(true);
    render(
      <RequestUserInputCard
        payload={{
          request_id: 7,
          item_id: "item-9",
          questions: [
            {
              id: "scope",
              question: "Which scope?",
              options: [{ label: "Local" }, { label: "Project" }],
            },
          ],
        }}
        onSubmit={submit}
      />,
    );
    await act(async () => element("request-user-input-option-scope-1").click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      requestId: 7,
      itemId: "item-9",
      answers: { scope: { answers: ["Project"] } },
    });
  });

  it.each([
    "/workspace/notes.md",
    String.raw`/workspace/report\2026.md`,
    String.raw`C:\workspace\notes.md`,
    String.raw`docs\notes.md`,
  ])("opens reference %s at its original file and line range", (path) => {
    const openFile = vi.fn();
    render(
      <CodexReferenceList
        references={[{ path, lineStart: 5, lineEnd: 8 }]}
        onOpenFile={openFile}
      />,
    );
    act(() => element("codex-reference-card").click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith(path, {
      lineStart: 5,
      lineEnd: 8,
    });
    expect(element("codex-reference-kind-label").textContent).toBe(
      "Document · MD",
    );
    expect(
      element("codex-reference-card").querySelector(".font-semibold")
        ?.textContent,
    ).toBe(
      path === String.raw`/workspace/report\2026.md`
        ? String.raw`report\2026.md`
        : "notes.md",
    );
  });

  it.each([
    [String.raw`/workspace/report\2026.md`, String.raw`report\2026.md`],
    [String.raw`C:\workspace\notes.md`, String.raw`docs\..\notes.md`],
  ])("merges absolute and relative references for %s", (absolute, relative) => {
    for (const paths of [
      [absolute, relative],
      [relative, absolute],
    ]) {
      const references = getAssistantReferences(
        paths.map((path) => ({ path })),
        "",
      );
      expect(references).toHaveLength(1);
      expect(references[0].path).toBe(absolute);
    }
  });

  it("captures the selected occurrence and its source message instead of matching the first occurrence", () => {
    container.innerHTML = '<article data-message-id="source"><div data-message-selectable-text>repeat then repeat</div></article>';
    const body = container.querySelector('[data-message-selectable-text]')!;
    const range = document.createRange();
    range.setStart(body.firstChild!, 12);
    range.setEnd(body.firstChild!, 18);
    range.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const state = createMessageTextSelectionState("conversation", false, true);
    const detach = state.attach(container);
    try {
      state.update();
      expect(state.getSnapshot().textSelection).toMatchObject({
        text: "repeat", messageId: "source", content: "repeat then repeat", start: 12,
      });
    } finally {
      selection.removeAllRanges();
      detach();
    }
  });

  it("extracts code selection without code toolbar text or embedded theme CSS", () => {
    container.innerHTML = '<article data-message-id="code-source"><div data-message-selectable-text><p>The path is:</p><div data-testid="markdown-code-block"><div><span data-testid="markdown-code-block-language">plaintext</span><button>Copy code</button></div><style data-pierre-code-theme>.pierre-code-block { color: red }</style><pre><code><span>/Users</span><span>/axb/work</span></code></pre></div></div></article>';
    const code = container.querySelector('code')!;
    const range = document.createRange();
    range.setStart(code.lastChild!.firstChild!, 0);
    range.setEnd(code.lastChild!.firstChild!, 9);
    range.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const state = createMessageTextSelectionState("conversation", false, true);
    const detach = state.attach(container);
    try {
      state.update();
      const captured = state.getSnapshot().textSelection!;
      expect(captured.content).toBe("The path is:\n/Users/axb/work");
      expect(captured.text).toBe("/axb/work");
      expect(captured.content.slice(captured.start, captured.start + captured.text.length)).toBe("/axb/work");
      expect(captured.content).not.toMatch(/pierre|plaintext|Copy code|color/);
    } finally {
      selection.removeAllRanges();
      detach();
    }
  });

  it("keeps selections before newly loaded successors using native transcript positions", () => {
    const excerpt = (id: string, position: number) => ({ id, role: "assistant" as const, content: id, order: [position, 0] as [number, number] });
    const source = excerpt("source", 2);
    const selection = { excerpt: source, start: 0, end: 3, followingMessageIds: ["last"] };
    expect(selectedShareExcerpts([excerpt("first", 1), excerpt("later-loaded", 3), excerpt("last", 4)], selection).map(value => value.id)).toEqual(["first", "source", "later-loaded", "last"]);
    expect(selectedShareExcerpts([excerpt("first", 1), source, excerpt("last", 4)], selection).map(value => value.id)).toEqual(["first", "source", "last"]);
  });

  it("captures all prose segments of one message and retains hard breaks", () => {
    container.innerHTML = '<article data-message-id="segments"><div data-message-selectable-text><p>alpha<br>beta</p></div><button>Tool details</button><div data-message-selectable-text><p>gamma beta</p></div></article>';
    const body = container.querySelectorAll('[data-message-selectable-text]')[1];
    const range = document.createRange();
    range.setStart(body.firstChild!.firstChild!, 6);
    range.setEnd(body.firstChild!.firstChild!, 10);
    range.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const state = createMessageTextSelectionState("conversation", false, true);
    const detach = state.attach(container);
    try {
      state.update();
      expect(state.getSnapshot().textSelection).toMatchObject({ text: "beta", content: "alpha\nbeta\n\ngamma beta", start: 18 });
      range.setStart(container.querySelector('[data-message-selectable-text]')!.firstChild!.firstChild!, 0);
      state.update();
      expect(state.getSnapshot().textSelection?.text).toBe("alpha\nbeta\n\ngamma beta");
    } finally {
      selection.removeAllRanges();
      detach();
    }
  });

  it("retains offscreen Markdown placeholder prose around the selected chunk", () => {
    vi.stubGlobal("IntersectionObserver", class {});
    try {
      container.innerHTML = renderToStaticMarkup(
        <article data-message-id="windowed"><div data-message-selectable-text>
          <WindowedMarkdownChunk chunkIndex={0} content="Before selection" eager={false}><p>Before selection</p></WindowedMarkdownChunk>
          <p data-selected>Selected prose</p>
          <WindowedMarkdownChunk chunkIndex={2} content="After selection" eager={false}><p>After selection</p></WindowedMarkdownChunk>
        </div></article>
      );
      expect(container.querySelectorAll('[data-markdown-window-placeholder]')).toHaveLength(2);
      const range = document.createRange();
      range.selectNodeContents(container.querySelector('[data-selected]')!);
      range.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
      document.getSelection()!.addRange(range);
      const state = createMessageTextSelectionState("conversation", false, true);
      const detach = state.attach(container);
      state.update();
      const capture = state.getSnapshot().textSelection!;
      expect(capture.content).toContain("Before selection");
      expect(capture.content).toContain("After selection");
      expect(capture.content.slice(capture.start, capture.start + capture.text.length)).toBe("Selected prose");
      detach();
    } finally {
      document.getSelection()!.removeAllRanges();
      vi.unstubAllGlobals();
    }
  });

  it("certifies a retained Markdown placeholder only for its measured row width and scope", () => {
    let width = 640;
    let top = 0;
    const intersections: IntersectionObserverCallback[] = [];
    const resizes: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersections.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizes.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this === container
          ? new DOMRect(0, 0, width, 600)
          : new DOMRect(0, top, width, 200);
      },
    );
    const scrollRef = { current: container };
    const first = createMarkdownWindowingScope(scrollRef, vi.fn());
    const second = createMarkdownWindowingScope(scrollRef, vi.fn());
    const mount = (scope: ReturnType<typeof createMarkdownWindowingScope>) =>
      act(() =>
        root.render(
          <MarkdownWindowingContext.Provider value={scope}>
            <div data-message-row>
              <WindowedMarkdownChunk
                chunkIndex={0}
                content="Measured prose"
                eager={false}
              >
                <p>Measured prose</p>
              </WindowedMarkdownChunk>
            </div>
          </MarkdownWindowingContext.Provider>,
        ),
      );
    const placeholder = () =>
      container.querySelector<HTMLElement>(
        "[data-markdown-window-placeholder]",
      );
    const move = (nextTop: number) => {
      top = nextTop;
      act(() =>
        intersections.at(-1)!(
          [{} as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
    };
    const resize = (nextWidth: number) => {
      width = nextWidth;
      act(() => resizes.at(-1)!([], {} as ResizeObserver));
    };
    try {
      mount(first);
      expect(placeholder()).toBeNull();
      move(3000);
      expect(placeholder()?.dataset.markdownPlaceholderRowWidth).toBe("640");
      resize(320);
      expect(placeholder()?.dataset.markdownPlaceholderRowWidth).toBe("640");
      resize(640);
      mount(second);
      // The old rendered height still exists, but it belongs to the previous scope.
      expect(
        placeholder()?.dataset.markdownPlaceholderRowWidth,
      ).toBeUndefined();
      move(0);
      expect(placeholder()).toBeNull();
      move(3000);
      expect(placeholder()?.dataset.markdownPlaceholderRowWidth).toBe("640");
    } finally {
      act(() => root.render(null));
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("shows the full selected message, highlights the exact occurrence and retains other messages", () => {
    const source = { id: "source", role: "assistant" as const, content: "repeat then repeat" };
    const other = { id: "other", role: "user" as const, content: "Another message" };
    const last = { id: "last", role: "assistant" as const, content: "Last message" };
    function SharePreview() {
      const [selected, setSelected] = useState([source.id]);
      const [whole, setWhole] = useState(false);
      return <TaskIssueShareExcerpts
        excerpts={[other, last]}
        firstAvailable
        selection={{ excerpt: source, start: 12, end: 18, followingMessageIds: [last.id] }}
        selected={selected}
        onSelect={setSelected}
        shareWholeMessage={whole}
        onShareWholeMessage={setWhole}
        renderShareContent={(messages, actions) => <>{actions}{messages}</>}
      />;
    }
    render(<SharePreview />);
    const highlight = element("task-issue-share-highlight");
    expect(highlight.textContent).toBe("repeat");
    expect(highlight.previousSibling?.textContent).toBe("repeat then ");
    expect(highlight.parentElement?.textContent).toBe(source.content);
    const rows = Array.from(document.querySelectorAll('[data-testid="task-issue-share-excerpt"]'));
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.textContent)).toEqual([expect.stringContaining(other.content), expect.stringContaining(source.content), expect.stringContaining(last.content)]);
    expect(rows[1].getAttribute("aria-pressed")).toBe("mixed");
    expect(element("task-issue-share-excerpt-partial")).toBeTruthy();
    const selectAll = element("task-issue-share-select-all");
    act(() => selectAll.click());
    expect(selectAll.getAttribute("aria-pressed")).toBe("true");
    expect(rows[1].getAttribute("aria-pressed")).toBe("mixed");
    expect(element("task-issue-share-highlight").textContent).toBe("repeat");
    act(() => selectAll.click());
    expect(rows[1].getAttribute("aria-pressed")).toBe("false");
    act(() => (rows[1] as HTMLElement).click());
    act(() => (rows[1] as HTMLElement).click());
    expect(rows[1].getAttribute("aria-pressed")).toBe("false");
    act(() => (rows[1] as HTMLElement).click());
    expect(rows[1].getAttribute("aria-pressed")).toBe("mixed");
    act(() => (rows[0] as HTMLElement).click());
    expect(rows[0].getAttribute("aria-pressed")).toBe("true");
    act(() => element("task-issue-share-whole-message").click());
    expect(element("task-issue-share-whole-message").getAttribute("aria-pressed")).toBe("true");
    expect(element("task-issue-share-whole-message").getAttribute("aria-label")).toBe("Share selected text only");
    expect(element("task-issue-share-highlight").textContent).toBe(source.content);
    act(() => element("task-issue-share-whole-message").click());
    expect(element("task-issue-share-whole-message").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps selection actions themed, localized and bound to real callbacks", () => {
    const add = vi.fn();
    const share = vi.fn();
    render(
      <SelectionActionsPopover
        position={{ left: 50, top: 80 }}
        onAddToConversation={add}
        onShareAsIssue={share}
      />,
    );
    const popup = element("message-selection-actions");
    expect(popup.dataset.theme).toBe("dark");
    expect(popup.style.left).toBe("50px");
    expect(container.contains(popup)).toBe(false);
    expect(
      document.querySelector('[data-testid="ask-selection-in-sidebar-button"]'),
    ).toBeNull();
    act(() => element("add-selection-to-conversation-button").click());
    expect(add).toHaveBeenCalledOnce();
    act(() => element("share-selection-as-issue-button").click());
    expect(share).toHaveBeenCalledOnce();
    expect(popup.textContent).toContain("Share with others");
    expect(popup.textContent).toContain("Add to conversation");
  });
});
