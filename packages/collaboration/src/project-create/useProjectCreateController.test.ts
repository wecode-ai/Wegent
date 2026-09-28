// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { projectCreateLabels } from "./labels";
import { RepositoryProviderError } from "./projectProviderConfig";
import {
  defaultExecutionEnvironmentDeviceIds,
  projectCreateErrorMessage,
} from "./useProjectCreateController";

describe("projectCreateErrorMessage", () => {
  it("maps stable repository validation codes through the active locale", () => {
    expect(
      projectCreateErrorMessage(
        new RepositoryProviderError("github_repository_invalid"),
        projectCreateLabels.en,
      ),
    ).toBe("A GitHub repository must include owner/repository");
    expect(
      projectCreateErrorMessage(
        new RepositoryProviderError("repository_required"),
        projectCreateLabels["zh-CN"],
      ),
    ).toBe("请输入仓库地址");
  });
});

describe("defaultExecutionEnvironmentDeviceIds", () => {
  it("selects only the current online registered local device", () => {
    expect(
      defaultExecutionEnvironmentDeviceIds([
        {
          id: "current-local",
          device_id: 42,
          device_key: "current-device",
          name: "Current Mac",
          kind: "local_device",
          coding_tools: ["codex"],
          owner_type: "user",
          owner_id: "7",
          owner_name: "User",
          status: "online",
          is_current_device: true,
          updated_at: "2026-09-21T00:00:00Z",
        },
        {
          id: "offline-current-local",
          device_id: 43,
          device_key: "offline-current-device",
          name: "Offline Mac",
          kind: "local_device",
          coding_tools: ["codex"],
          owner_type: "user",
          owner_id: "7",
          owner_name: "User",
          status: "offline",
          is_current_device: true,
          updated_at: "2026-09-21T00:00:00Z",
        },
        {
          id: "other-local",
          device_id: 44,
          device_key: "other-device",
          name: "Other Mac",
          kind: "local_device",
          coding_tools: ["codex"],
          owner_type: "user",
          owner_id: "7",
          owner_name: "User",
          status: "online",
          updated_at: "2026-09-21T00:00:00Z",
        },
        {
          id: "temporary-current-local",
          device_id: 0,
          device_key: "temporary-current-device",
          name: "Unregistered Mac",
          kind: "local_device",
          coding_tools: ["codex"],
          owner_type: "workspace",
          owner_id: "local",
          owner_name: "Local",
          status: "online",
          is_current_device: true,
          updated_at: "2026-09-21T00:00:00Z",
        },
      ]),
    ).toEqual([42]);
  });
});
