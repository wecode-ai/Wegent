// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationProject,
} from "../types";
import { ProjectExecutionEnvironments } from "./ProjectExecutionEnvironments";

const project: CollaborationProject = {
  id: "project-1",
  workspace_id: "workspace-1",
  public_id: "project-public-1",
  project_key: "PRJ",
  name: "Project",
  description: "",
  project_store: "backend",
  task_provider: "local",
  provider_config: {},
  created_by_user_id: 1,
  access_role: "Owner",
  status: "active",
  tags: [],
  version: 1,
  created_at: "2026-09-14T00:00:00Z",
  updated_at: "2026-09-14T00:00:00Z",
};

function environment(
  deviceId: number,
  name: string,
  status: CollaborationExecutionEnvironment["status"],
): CollaborationExecutionEnvironment {
  return {
    id: `environment-${deviceId}`,
    device_id: deviceId,
    device_key: `device-${deviceId}`,
    name,
    kind: "local_device",
    coding_tools: ["codex"],
    owner_type: "user",
    owner_id: "1",
    owner_name: "Owner",
    status,
    updated_at: "2026-09-14T00:00:00Z",
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("ProjectExecutionEnvironments", () => {
  it("only offers online execution environments for project selection", async () => {
    const onlinePersonal = environment(21, "Online personal", "online");
    const offlinePersonal = environment(22, "Offline personal", "offline");
    const onlineShared = environment(23, "Online shared", "online");
    const errorShared = environment(24, "Error shared", "error");
    const api = {
      projects: {
        listExecutionEnvironments: vi.fn(async () => []),
      },
      resources: {
        list: vi.fn(async () => ({
          agents: [],
          execution_environments: [onlinePersonal, offlinePersonal],
        })),
      },
      workspaces: {
        listExecutionEnvironments: vi.fn(async () => [
          onlineShared,
          errorShared,
        ]),
      },
    } as unknown as SharedWorkspaceApi;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ProjectExecutionEnvironments
          api={api}
          project={project}
          translate={(_key, fallback) => fallback}
        />,
      );
    });

    const options = [
      ...container.querySelectorAll<HTMLSelectElement>(
        '[data-testid="collaboration-project-execution-environment-select"] option',
      ),
    ].map((option) => option.textContent);

    expect(options).toEqual([
      "选择执行环境",
      "Online personal · 我的资源",
      "Online shared · 空间共享",
    ]);
  });
});
