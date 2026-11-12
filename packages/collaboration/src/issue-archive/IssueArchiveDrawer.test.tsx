// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationIssue } from "../types";
import { IssueArchiveDrawer } from "./IssueArchiveDrawer";

const first = {
  id: "first",
  title: "Archived first",
  can_edit: true,
  archived_at: "2026-11-12T00:00:00Z",
} as CollaborationIssue;
const second = { ...first, id: "second", title: "Archived second" };
function props(): ComponentProps<typeof IssueArchiveDrawer> {
  return {
    busyId: null,
    error: null,
    items: [first, second],
    loading: false,
    nextCursor: null,
    onClose: vi.fn(),
    onLoadMore: vi.fn(),
    onRestore: vi.fn(),
    translate: (_key, fallback) => fallback ?? _key,
  };
}
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
function render(
  values: ComponentProps<typeof IssueArchiveDrawer>,
  embedded = false,
) {
  act(() =>
    root.render(
      embedded ? (
        <div className="issue-drawer-workspace">
          <IssueArchiveDrawer {...values} />
        </div>
      ) : (
        <IssueArchiveDrawer {...values} />
      ),
    ),
  );
}
const close = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-testid="collaboration-issue-archive-drawer-close"]',
  )!;
const restore = (id: string) =>
  container.querySelector<HTMLButtonElement>(
    `[data-testid="collaboration-archived-issue-restore-${id}"]`,
  )!;

describe("IssueArchiveDrawer", () => {
  it("preserves the named header, close action and full viewport default outside an embedded host", () => {
    const values = props();
    render(values);
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe(
      "已归档",
    );
    expect(container.querySelector("h2")?.textContent).toBe("已归档");
    expect(
      container
        .querySelector(".issue-archive-overlay")
        ?.classList.contains("fixed"),
    ).toBe(true);
    expect(container.textContent).toContain(first.title);
    expect(container.textContent).toContain(second.title);
    expect(close().textContent).toBe("关闭");
    act(() => close().click());
    expect(values.onClose).toHaveBeenCalledOnce();
    expect(values.onRestore).not.toHaveBeenCalled();
  });

  it("keeps embedded content actions separate from backdrop dismissal", () => {
    const values = props();
    render(values, true);
    const overlay = container.querySelector<HTMLElement>(
      ".issue-archive-overlay",
    )!;
    expect(
      overlay.parentElement?.classList.contains("issue-drawer-workspace"),
    ).toBe(true);
    act(() =>
      restore(first.id).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      ),
    );
    expect(values.onClose).not.toHaveBeenCalled();
    act(() => restore(first.id).click());
    expect(values.onRestore).toHaveBeenCalledExactlyOnceWith(first);
    expect(values.onClose).not.toHaveBeenCalled();
    act(() =>
      overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(values.onClose).toHaveBeenCalledOnce();
  });

  it("blocks duplicate restores while preserving the explicit close control", () => {
    const values = { ...props(), busyId: first.id };
    render(values);
    expect(restore(first.id).disabled).toBe(true);
    expect(restore(second.id).disabled).toBe(true);
    expect(restore(first.id).textContent).toBe("恢复中…");
    act(() => {
      restore(first.id).click();
      restore(second.id).click();
      close().click();
    });
    expect(values.onRestore).not.toHaveBeenCalled();
    expect(values.onClose).toHaveBeenCalledOnce();
  });

  it("retains the header, close and readable rows during loading and failure", () => {
    const values = {
      ...props(),
      loading: true,
      error: "Temporary archive read failure",
    };
    render(values);
    expect(container.querySelector("h2")?.textContent).toBe("已归档");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      values.error,
    );
    expect(container.textContent).toContain(first.title);
    expect(container.textContent).toContain("正在加载…");
    expect(close().disabled).toBe(false);
    act(() => close().click());
    expect(values.onClose).toHaveBeenCalledOnce();
  });

  it("does not expose a restore action for a read-only item", () => {
    render({ ...props(), items: [{ ...first, can_edit: false }] });
    expect(restore(first.id)).toBeNull();
    expect(close()).not.toBeNull();
    expect(container.textContent).toContain(first.title);
  });
});
