// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CollaborationProject } from "../types";
import { projectCreateLabels } from "./labels";
import { ProjectCreateMembersError } from "./configureProjectMembers";
import { useProjectCreateController } from "./useProjectCreateController";

const project = { id: "new-project", name: "Members" } as CollaborationProject;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function mountController(configure: () => Promise<void>) {
  const create = vi.fn(async () => project);
  const onCreated = vi.fn();
  let controller!: ReturnType<typeof useProjectCreateController>;
  function Harness() {
    controller = useProjectCreateController({
      targets: [{ location: "cloud", create }],
      defaultLocation: "cloud",
      allowDingTalkAITable: false,
      labels: projectCreateLabels.en,
      resourceSetup: {
        location: "cloud",
        currentUser: { id: 1, name: "Owner" },
        members: [],
        agents: [],
        groups: [],
        configure,
      },
      onCreated,
      onClose() {},
    });
    return null;
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
  await act(async () => {
    controller.commands.setName("Members");
    controller.commands.setMemberUserIds([2, 3]);
  });
  return { create, onCreated, current: () => controller };
}

describe("project resource configuration recovery", () => {
  it("retries the existing project after a member add failure and preserves selection", async () => {
    const configure = vi
      .fn()
      .mockRejectedValueOnce(
        new ProjectCreateMembersError(
          [{ userId: 2, userName: "Ada", reason: "permission denied" }],
          [],
        ),
      )
      .mockResolvedValueOnce(undefined);
    const harness = await mountController(configure);

    await act(async () => harness.current().commands.submit());
    expect(harness.current().state.error).toContain("Ada: permission denied");
    expect(harness.current().state.memberSetupFailed).toBe(true);
    expect(harness.current().state.memberUserIds).toEqual([2, 3]);
    expect(harness.onCreated).not.toHaveBeenCalled();

    await act(async () => harness.current().commands.submit());
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure.mock.calls[1]?.[0]).toBe(project);
    expect(configure.mock.calls[1]?.[1]).toBe(configure.mock.calls[0]?.[1]);
    expect(harness.onCreated).toHaveBeenCalledWith(project, "cloud");
  });

  it("retries an empty failure list after roster refresh fails and opens the configured result", async () => {
    const configured = { ...project, version: 2 };
    const configure = vi
      .fn()
      .mockRejectedValueOnce(
        new ProjectCreateMembersError([], [], "Roster refresh failed"),
      )
      .mockResolvedValueOnce(configured);
    const harness = await mountController(configure);

    await act(async () => harness.current().commands.submit());
    expect(harness.current().state.memberSetupFailed).toBe(true);
    expect(harness.current().state.error).toContain("Roster refresh failed");
    expect(harness.onCreated).not.toHaveBeenCalled();
    await act(async () => harness.current().commands.submit());
    await act(async () => harness.current().commands.submit());

    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(2);
    expect(harness.onCreated).toHaveBeenCalledExactlyOnceWith(
      configured,
      "cloud",
    );
  });

  it("ignores simultaneous submissions while project creation is pending", async () => {
    const configure = vi.fn(async () => {});
    const harness = await mountController(configure);

    await act(async () => {
      await Promise.all([
        harness.current().commands.submit(),
        harness.current().commands.submit(),
      ]);
    });

    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.onCreated).toHaveBeenCalledTimes(1);
  });
});
