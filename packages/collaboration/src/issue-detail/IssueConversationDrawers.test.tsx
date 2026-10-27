// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueConversationDrawers } from "./IssueConversationDrawers";
import { IssueTaskConversationPanel } from "./IssueTaskConversationPanel";
import { createCollaborationTranslator } from "../i18n";

describe("IssueConversationDrawers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalGetAnimations: typeof Element.prototype.getAnimations | undefined;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    originalGetAnimations = Element.prototype.getAnimations;
    Element.prototype.getAnimations = vi.fn(() => []);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalGetAnimations)
      Element.prototype.getAnimations = originalGetAnimations;
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
  });

  it("commits a dismiss once when the parent supplies a new onClose on every render", async () => {
    const close = vi.fn();
    const onCloseIdentities = new Set<() => void>();
    let rerenderParent = () => {};

    function Harness() {
      const [, setRender] = useState(0);
      rerenderParent = () => setRender((value) => value + 1);
      const onClose = () => close();
      onCloseIdentities.add(onClose);
      return (
        <IssueConversationDrawers
          label="Issue detail"
          conversation={null}
          onClose={onClose}
          onCloseConversation={vi.fn()}
        >
          {(requestClose) => (
            <button type="button" onClick={requestClose}>
              Close
            </button>
          )}
        </IssueConversationDrawers>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });

    expect(close).toHaveBeenCalledTimes(1);

    await act(async () => rerenderParent());
    await act(async () => rerenderParent());

    expect(onCloseIdentities.size).toBeGreaterThanOrEqual(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "expands and restores a task without replacing its composer (existing: %s)",
    async (existingTask) => {
      const close = vi.fn();
      function Harness() {
        const [showConversation, setShowConversation] = useState(true);
        return (
          <IssueConversationDrawers
            label="Issue detail"
            conversationKey="device:task"
            conversation={
              showConversation ? (
                <IssueTaskConversationPanel
                  existingTask={existingTask}
                  translate={createCollaborationTranslator("en")}
                  onClose={() => setShowConversation(false)}
                >
                  <textarea
                    aria-label="Task draft"
                    defaultValue="Keep my task draft"
                  />
                </IssueTaskConversationPanel>
              ) : null
            }
            onClose={close}
            onCloseConversation={() => setShowConversation(false)}
          >
            {() => (
              <>
                <textarea
                  aria-label="Issue draft"
                  defaultValue="Keep my Issue draft"
                />
                <button type="button" onClick={() => setShowConversation(true)}>
                  Open task
                </button>
              </>
            )}
          </IssueConversationDrawers>
        );
      }
      await act(async () => root.render(<Harness />));
      const track = container.querySelector(
        '[data-testid="issue-conversation-drawers"]',
      )!;
      const detail = container.querySelector(".issue-drawer-detail")!;
      const conversation = container.querySelector(
        '[data-testid="ai-chat-modal"]',
      )!;
      const composer = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Task draft"]',
      )!;
      const issueDraft = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Issue draft"]',
      )!;
      detail.scrollTop = 120;
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="ai-chat-modal-toggle-expanded"]',
      )!;

      await act(async () => toggle.click());

      expect(track.getAttribute("data-conversation-expanded")).toBe("true");
      expect(detail.hasAttribute("inert")).toBe(true);
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(toggle.getAttribute("aria-label")).toBe("Restore conversation");
      expect(container.querySelector('[data-testid="ai-chat-modal"]')).toBe(
        conversation,
      );
      expect(container.querySelector('[aria-label="Task draft"]')).toBe(
        composer,
      );
      expect(composer.value).toBe("Keep my task draft");

      await act(async () => toggle.click());

      expect(track.getAttribute("data-conversation-expanded")).toBe("false");
      expect(detail.hasAttribute("inert")).toBe(false);
      expect(toggle.getAttribute("aria-label")).toBe("Expand conversation");
      expect(container.querySelector('[aria-label="Task draft"]')).toBe(
        composer,
      );
      expect(container.querySelector('[aria-label="Issue draft"]')).toBe(
        issueDraft,
      );
      expect(issueDraft.value).toBe("Keep my Issue draft");
      expect(detail.scrollTop).toBe(120);

      await act(async () => toggle.click());
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="ai-chat-modal-close"]',
          )!
          .click(),
      );

      expect(track.getAttribute("data-conversation-expanded")).toBe("false");
      expect(detail.hasAttribute("inert")).toBe(false);
      expect(
        container.querySelector('[data-testid="ai-chat-modal"]'),
      ).toBeNull();
      expect(close).not.toHaveBeenCalled();
      expect(issueDraft.value).toBe("Keep my Issue draft");

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(".issue-drawer-detail button")!
          .click(),
      );

      expect(track.getAttribute("data-conversation-expanded")).toBe("false");
      expect(
        container
          .querySelector('[data-testid="ai-chat-modal-toggle-expanded"]')
          ?.getAttribute("aria-pressed"),
      ).toBe("false");
    },
  );

  it("retains the expanded surface until closing motion finishes", async () => {
    let finishMotion = () => {};
    const animation = {
      playState: "running",
      finished: new Promise<void>((resolve) => {
        finishMotion = resolve;
      }),
    };
    let closeConversation = () => {};
    function Harness() {
      const [open, setOpen] = useState(true);
      closeConversation = () => setOpen(false);
      return (
        <IssueConversationDrawers
          label="Issue detail"
          conversation={
            open ? (
              <IssueTaskConversationPanel
                existingTask
                translate={createCollaborationTranslator("zh-CN")}
                onClose={closeConversation}
              >
                Conversation
              </IssueTaskConversationPanel>
            ) : null
          }
          onClose={vi.fn()}
          onCloseConversation={closeConversation}
        >
          {() => <textarea aria-label="Issue draft" />}
        </IssueConversationDrawers>
      );
    }
    await act(async () => root.render(<Harness />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="放大对话"]')!
        .click(),
    );
    Element.prototype.getAnimations = vi.fn(() => [
      animation as unknown as Animation,
    ]);
    await act(async () => closeConversation());

    const track = container.querySelector(
      '[data-testid="issue-conversation-drawers"]',
    )!;
    expect(track.getAttribute("data-conversation-expanded")).toBe("true");
    expect(
      container
        .querySelector(".issue-drawer-conversation")!
        .hasAttribute("inert"),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="ai-chat-modal"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(".issue-drawer-detail")!.hasAttribute("inert"),
    ).toBe(false);

    await act(async () => {
      animation.playState = "finished";
      finishMotion();
      await animation.finished;
    });

    expect(track.getAttribute("data-conversation-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="ai-chat-modal"]')).toBeNull();
  });
});
