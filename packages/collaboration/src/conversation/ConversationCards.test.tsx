// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnFileChangesSummary } from "@wegent/chat-core/runtime";
import { createCollaborationTranslator } from "../i18n";
import { CollaborationTheme } from "../theme";
import { ConversationTranslationProvider } from "./ConversationTranslation";
import { FileChangesCard } from "./FileChangesCard";
import { RequestUserInputCard } from "./RequestUserInputCard";
import { CodexReferenceList } from "./CodexTurnArtifacts";
import { SelectionActionsPopover } from "./SelectionActionsPopover";

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
function render(children: ReactNode) {
  act(() =>
    root.render(
      <CollaborationTheme mode="dark">
        <ConversationTranslationProvider
          translate={createCollaborationTranslator("en")}
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

  it("opens a reference at its original file and line range", () => {
    const openFile = vi.fn();
    render(
      <CodexReferenceList
        references={[{ path: "/workspace/notes.md", lineStart: 5, lineEnd: 8 }]}
        onOpenFile={openFile}
      />,
    );
    act(() => element("codex-reference-card").click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith("/workspace/notes.md", {
      lineStart: 5,
      lineEnd: 8,
    });
    expect(element("codex-reference-kind-label").textContent).toBe(
      "Document · MD",
    );
  });

  it("keeps selection actions themed, localized and bound to real callbacks", () => {
    const add = vi.fn();
    render(
      <SelectionActionsPopover
        position={{ left: 50, top: 80 }}
        onAddToConversation={add}
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
    expect(popup.textContent).toContain("Add to conversation");
  });
});
