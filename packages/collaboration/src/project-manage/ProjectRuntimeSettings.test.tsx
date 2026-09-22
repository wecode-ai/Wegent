// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import type {
  SharedWorkspaceApi,
  WorkspaceRuntimeProfile,
} from "../ports/SharedWorkspaceApi";
import { ProjectRuntimeSettings } from "./ProjectRuntimeSettings";

const profile: WorkspaceRuntimeProfile = {
  id: "profile-1",
  name: "My cloud runtime",
  executionEnvironment: "cloud",
  executionDeviceId: "cloud-1",
  model: "model-1",
  modelType: "group",
  modelOptions: { weworkCloudModelNamespace: "engineering" },
  status: "active",
  version: 1,
};
let root: Root | null = null;
let container: HTMLDivElement;
const navigate = vi.fn();
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.clearAllMocks();
});
function element<T extends HTMLElement>(name: string): T {
  const result = container.querySelector<T>(
    `[data-testid="project-runtime-${name}"]`,
  );
  if (!result) throw new Error(`Missing control ${name}`);
  return result;
}
async function click(name: string) {
  await act(async () => element(name).click());
}
async function change(name: string, value: string) {
  await act(async () => {
    const target = element<HTMLInputElement | HTMLSelectElement>(name);
    if (target instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      target.value = value;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}
async function render({
  profiles = [profile],
  defaultId = null,
  noDevices = false,
  failedSave = false,
}: {
  profiles?: WorkspaceRuntimeProfile[];
  defaultId?: string | null;
  noDevices?: boolean;
  failedSave?: boolean;
} = {}) {
  const setDefault = vi.fn().mockResolvedValue({
    projectId: "project-1",
    runtimeProfileId: "profile-1",
    userId: 1,
  });
  if (failedSave)
    setDefault.mockRejectedValueOnce(new Error("Could not save binding"));
  const api = {
    automationExecutionCatalog: {
      load: vi.fn(async () => ({
        environments: noDevices
          ? []
          : [
              {
                deviceId: "cloud-1",
                label: "Cloud",
                executionEnvironment: "cloud",
              },
            ],
        models: [
          {
            name: "native",
            label: "Runtime native",
            type: "runtime",
            options: {},
          },
          {
            name: "model-1",
            label: "Group model",
            type: "group",
            options: profile.modelOptions,
          },
        ],
        runtimeProfiles: profiles,
        plugins: [],
      })),
    },
    runtimeProfiles: {
      getProjectDefault: vi.fn(async () => ({ runtimeProfileId: defaultId })),
      create: vi.fn(async () => profile),
      setProjectDefault: setDefault,
    },
  } as unknown as SharedWorkspaceApi;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <ProjectRuntimeSettings
        api={api}
        projectId="project-1"
        translate={createCollaborationTranslator("zh-CN")}
        onConfigureEnvironments={navigate}
      />,
    ),
  );
  return api;
}

describe("ProjectRuntimeSettings", () => {
  it("shows missing configuration and saves an existing complete profile", async () => {
    const api = await render();
    expect(element("missing").textContent).toContain("AI 调度器无法启动");
    expect(element<HTMLButtonElement>("save").disabled).toBe(true);
    await change("profile", "profile-1");
    await click("save");
    expect(
      api.runtimeProfiles.setProjectDefault,
    ).toHaveBeenCalledExactlyOnceWith("project-1", "profile-1");
    expect(element("current").textContent).toContain("model-1");
    expect(
      container.querySelector('[data-testid="project-runtime-missing"]'),
    ).toBeNull();
  });
  it("does not allow an incomplete profile to become the project default", async () => {
    await render({
      profiles: [{ ...profile, model: "" }],
      defaultId: "profile-1",
    });
    expect(element("missing").textContent).toContain("设备和模型");
    expect(element<HTMLButtonElement>("save").disabled).toBe(true);
  });
  it("creates a cloud profile with the selected model identity and retries binding without duplicate creation", async () => {
    const api = await render({ profiles: [], failedSave: true });
    await click("create");
    await change("name", "Cloud coordinator");
    await change("device", "cloud-1");
    expect(element<HTMLSelectElement>("model").textContent).not.toContain(
      "Runtime native",
    );
    await change("model", "1");
    await click("save");
    expect(api.runtimeProfiles.create).toHaveBeenCalledExactlyOnceWith({
      name: "Cloud coordinator",
      executionEnvironment: "cloud",
      executionDeviceId: "cloud-1",
      model: "model-1",
      modelType: "group",
      modelOptions: profile.modelOptions,
      workspacePolicy: "git_worktree",
    });
    expect(container.textContent).toContain("Could not save binding");
    await click("save");
    expect(api.runtimeProfiles.create).toHaveBeenCalledTimes(1);
    expect(element("current").textContent).toContain("model-1");
  });
  it("provides a working environment configuration entry when no device is available", async () => {
    await render({ noDevices: true });
    await click("create");
    await click("configure-environments");
    expect(navigate).toHaveBeenCalledOnce();
    expect(element<HTMLButtonElement>("save").disabled).toBe(true);
  });
});
