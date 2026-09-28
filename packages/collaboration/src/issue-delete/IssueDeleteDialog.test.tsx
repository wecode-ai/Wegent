// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollaborationTranslate } from "../i18n";
import { collaborationTestIds } from "../testIds";
import { IssueDeleteDialog } from "./IssueDeleteDialog";

const translate: CollaborationTranslate = (key, fallback, options) => {
  let text = fallback ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replace(`{{${name}}}`, String(value));
  }
  return text;
};

describe("IssueDeleteDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderDialog(
    overrides: Partial<Parameters<typeof IssueDeleteDialog>[0]> = {},
  ) {
    const props: Parameters<typeof IssueDeleteDialog>[0] = {
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
      root.render(<IssueDeleteDialog {...props} />);
    });
    return props;
  }

  it("names the Issue and explains the soft-delete and execution stop", async () => {
    await renderDialog();

    const dialog = container.querySelector(
      `[data-testid="${collaborationTestIds.issueDeleteDialog}"]`,
    );
    expect(dialog?.textContent).toContain("整理看板");
    expect(dialog?.textContent).toContain("将从看板中隐藏");
    expect(dialog?.textContent).toContain("AI 运行会被停止");
    expect(dialog?.textContent).toContain("不会立即永久删除");
  });

  it("mentions sub-issues when the Issue has children", async () => {
    await renderDialog({ hasChildren: true });

    const dialog = container.querySelector(
      `[data-testid="${collaborationTestIds.issueDeleteDialog}"]`,
    );
    expect(dialog?.textContent).toContain("及其子任务");
  });

  it("invokes confirm and cancel callbacks", async () => {
    const props = await renderDialog();

    const confirm = container.querySelector<HTMLButtonElement>(
      `[data-testid="${collaborationTestIds.issueDeleteConfirm}"]`,
    );
    const cancel = container.querySelector<HTMLButtonElement>(
      `[data-testid="${collaborationTestIds.issueDeleteCancel}"]`,
    );
    await act(async () => {
      confirm?.click();
      cancel?.click();
    });

    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the failure and disables actions while busy", async () => {
    await renderDialog({ busy: true, error: "停止执行失败" });

    const error = container.querySelector(
      `[data-testid="${collaborationTestIds.issueDeleteError}"]`,
    );
    expect(error?.textContent).toBe("停止执行失败");
    const confirm = container.querySelector<HTMLButtonElement>(
      `[data-testid="${collaborationTestIds.issueDeleteConfirm}"]`,
    );
    const cancel = container.querySelector<HTMLButtonElement>(
      `[data-testid="${collaborationTestIds.issueDeleteCancel}"]`,
    );
    expect(confirm?.disabled).toBe(true);
    expect(cancel?.disabled).toBe(true);
  });
});
