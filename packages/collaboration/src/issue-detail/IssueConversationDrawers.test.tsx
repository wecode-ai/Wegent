// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueConversationDrawers } from "./IssueConversationDrawers";

describe("IssueConversationDrawers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let diagnostics: unknown[][];
  let originalGetAnimations: typeof Element.prototype.getAnimations | undefined;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    diagnostics = [];
    vi.spyOn(console, "debug").mockImplementation((...args) =>
      diagnostics.push(args),
    );
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
    vi.restoreAllMocks();
  });

  it("keeps the Issue open until its exit animation finishes", async () => {
    const close = vi.fn();
    let finishAnimation!: () => void;
    const animation = {
      playState: "running",
      finished: new Promise<void>((resolve) => {
        finishAnimation = resolve;
      }),
    };
    await act(async () =>
      root.render(
        <IssueConversationDrawers
          label="Issue detail"
          conversation={null}
          onClose={close}
          onCloseConversation={vi.fn()}
        >
          {(requestClose) => <button onClick={requestClose}>Close</button>}
        </IssueConversationDrawers>,
      ),
    );
    Element.prototype.getAnimations = vi.fn(
      () => [animation] as unknown as Animation[],
    );

    await act(async () => container.querySelector("button")?.click());

    expect(container.querySelector('[data-dismissing="true"]')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();

    await act(async () => {
      animation.playState = "finished";
      finishAnimation();
    });

    expect(close).toHaveBeenCalledTimes(1);
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

  it("distinguishes a canceled close from a new drawer after remount", async () => {
    const close = vi.fn();
    let finishAnimation!: () => void;
    const animation = {
      playState: "running",
      finished: new Promise<void>((resolve) => {
        finishAnimation = resolve;
      }),
    };
    const drawer = () => (
      <IssueConversationDrawers
        label="Private Issue title"
        conversation={null}
        onClose={close}
        onCloseConversation={vi.fn()}
      >
        {(requestClose) => <button onClick={requestClose}>Close</button>}
      </IssueConversationDrawers>
    );
    await act(async () => root.render(drawer()));
    const firstInstance = container.querySelector<HTMLElement>(
      "[data-diagnostic-instance]",
    )!.dataset.diagnosticInstance;
    Element.prototype.getAnimations = vi.fn(
      () => [animation] as unknown as Animation[],
    );
    await act(async () => container.querySelector("button")?.click());
    await act(async () => root.render(null));
    Element.prototype.getAnimations = vi.fn(() => []);
    await act(async () => root.render(drawer()));
    const secondInstance = container.querySelector<HTMLElement>(
      "[data-diagnostic-instance]",
    )!.dataset.diagnosticInstance;
    await act(async () => {
      animation.playState = "finished";
      finishAnimation();
    });
    expect(close).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")?.click());

    const events = diagnostics.map(
      (args) => args[1] as { instanceId: number; phase: string },
    );
    expect(secondInstance).not.toBe(firstInstance);
    expect(
      events
        .filter((event) => String(event.instanceId) === firstInstance)
        .map((event) => event.phase),
    ).toEqual(
      expect.arrayContaining([
        "request-close",
        "effect-canceled",
        "unmounted",
        "animations-settled",
      ]),
    );
    expect(
      events
        .filter((event) => String(event.instanceId) === secondInstance)
        .map((event) => event.phase),
    ).toEqual(
      expect.arrayContaining(["mounted", "request-close", "commit-callback"]),
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics)).not.toContain("Private Issue title");
  });
});
