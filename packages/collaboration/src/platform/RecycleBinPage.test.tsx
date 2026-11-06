// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorkspaceRecycleBinApi,
  WorkspaceRecycleBinItem,
} from "../ports/SharedWorkspaceApi";
import { RecycleBinPage } from "./RecycleBinPage";

const project: WorkspaceRecycleBinItem = {
  id: "17",
  kind: "project",
  name: "Retained project",
  workspaceId: "42",
  workspaceName: "Parent",
  version: 2,
  deletedAt: "2026-11-06T00:00:00Z",
  parentDeleted: false,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const button = (id: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const click = async (id: string) => {
  await act(async () => button(id).click());
};

it("retains rows after restore failure and allows an explicit retry", async () => {
  const api: WorkspaceRecycleBinApi = {
    list: vi.fn(async () => ({ items: [project], errors: [] })),
    restore: vi.fn(),
  };
  const restore = vi
    .fn()
    .mockRejectedValueOnce(new Error("Version conflict"))
    .mockResolvedValueOnce(undefined);
  await act(async () =>
    root.render(<RecycleBinPage api={api} locale="en" onRestore={restore} />),
  );
  const id = "collaboration-recycle-bin-restore-project-17";
  await click(id);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Version conflict",
  );
  expect(container.textContent).toContain(project.name);
  await click(id);
  expect(restore).toHaveBeenCalledTimes(2);
});

it("blocks child restoration until its parent space is restored", async () => {
  const api: WorkspaceRecycleBinApi = {
    list: vi.fn(async () => ({
      items: [{ ...project, parentDeleted: true }],
      errors: [],
    })),
    restore: vi.fn(),
  };
  const restore = vi.fn();
  await act(async () =>
    root.render(
      <RecycleBinPage api={api} locale="zh-CN" onRestore={restore} />,
    ),
  );
  expect(button("collaboration-recycle-bin-restore-project-17").disabled).toBe(
    true,
  );
  expect(container.textContent).toContain("请先恢复所属空间");
  await click("collaboration-recycle-bin-restore-project-17");
  expect(restore).not.toHaveBeenCalled();
});

it("preserves independently loaded local entries while reporting cloud failure", async () => {
  const api: WorkspaceRecycleBinApi = {
    list: vi.fn(async () => ({ items: [project], errors: ["Cloud offline"] })),
    restore: vi.fn(),
  };
  await act(async () =>
    root.render(<RecycleBinPage api={api} locale="en" onRestore={vi.fn()} />),
  );
  expect(container.textContent).toContain(project.name);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Cloud offline",
  );
  expect(button("collaboration-recycle-bin-refresh").disabled).toBe(false);
});

it("prevents repeated restores while one request is pending", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const restore = vi.fn(async () => pending);
  const api: WorkspaceRecycleBinApi = {
    list: vi.fn(async () => ({ items: [project], errors: [] })),
    restore: vi.fn(),
  };
  await act(async () =>
    root.render(<RecycleBinPage api={api} locale="en" onRestore={restore} />),
  );
  await click("collaboration-recycle-bin-restore-project-17");
  await click("collaboration-recycle-bin-restore-project-17");
  expect(restore).toHaveBeenCalledTimes(1);
  expect(button("collaboration-recycle-bin-refresh").disabled).toBe(true);
  await act(async () => resolve());
});
