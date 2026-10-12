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
});
