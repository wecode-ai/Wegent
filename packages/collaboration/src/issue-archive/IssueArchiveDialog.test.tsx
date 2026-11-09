// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollaborationTranslate } from "../i18n";
import { collaborationTestIds } from "../testIds";
import { IssueArchiveDialog } from "./IssueArchiveDialog";

const translate: CollaborationTranslate = (key, fallback, options) => {
  let text = fallback ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replace(`{{${name}}}`, String(value));
  }
  return text;
};
const originalDialogMethods = Object.getOwnPropertyDescriptors(
  HTMLDialogElement.prototype,
);

describe("IssueArchiveDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.open = true;
        },
      },
      close: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.open = false;
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    for (const method of ["showModal", "close"]) {
      const original = originalDialogMethods[method];
      if (original)
        Object.defineProperty(HTMLDialogElement.prototype, method, original);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    }
  });

  async function renderDialog(
    overrides: Partial<Parameters<typeof IssueArchiveDialog>[0]> = {},
  ) {
    const props: Parameters<typeof IssueArchiveDialog>[0] = {
      busy: false,
      error: null,
      hasChildren: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      title: "整理看板",
      translate,
      ...overrides,
    };
    await act(async () => {
      root.render(<IssueArchiveDialog {...props} />);
    });
    return props;
  }

  it("explains that a task can be restored from the archive box", async () => {
    await renderDialog();

    const dialog = container.querySelector(
      `[data-testid="${collaborationTestIds.issueArchiveDialog}"]`,
    );
    expect(dialog?.textContent).toContain("整理看板");
    expect(dialog?.textContent).toContain("将从看板中归档");
    expect(dialog?.textContent).toContain("归档箱恢复");
  });

  it("describes subtree and batch archives", async () => {
    await renderDialog({ hasChildren: true });
    expect(container.textContent).toContain("及其子任务将从看板中归档");
    expect(container.textContent).toContain("正在执行的 AI 运行会被停止");

    await renderDialog({ count: 3 });
    expect(container.textContent).toContain("归档 3 个已完成任务");
  });

  it("focuses Cancel and restores focus when the confirmation closes", async () => {
    const trigger = container;
    trigger.tabIndex = -1;
    trigger.focus();
    await renderDialog();
    expect(document.activeElement).toBe(
      container.querySelector(
        `[data-testid="${collaborationTestIds.issueArchiveCancel}"]`,
      ),
    );
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(trigger);
  });

  it("invokes callbacks and disables actions while busy", async () => {
    const props = await renderDialog();
    const confirm = container.querySelector<HTMLButtonElement>(
      `[data-testid="${collaborationTestIds.issueArchiveConfirm}"]`,
    );
    const cancel = container.querySelector<HTMLButtonElement>(
      `[data-testid="${collaborationTestIds.issueArchiveCancel}"]`,
    );
    await act(async () => {
      confirm?.click();
      cancel?.click();
    });
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    await renderDialog({ busy: true, error: "归档失败" });
    expect(
      container.querySelector(
        `[data-testid="${collaborationTestIds.issueArchiveError}"]`,
      )?.textContent,
    ).toBe("归档失败");
    expect(
      container.querySelector<HTMLButtonElement>(
        `[data-testid="${collaborationTestIds.issueArchiveConfirm}"]`,
      )?.disabled,
    ).toBe(true);
  });
});
