// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { builtinCollaborationTemplates } from "../templates/builtins";
import { useProjectCreateController } from "./useProjectCreateController";
import { projectCreateLabels } from "./labels";
import type { ProjectCreateDialogProps } from "./types";

it.each(["loading", "error"] as const)(
  "does not persist a template project while execution environments are %s",
  async (state) => {
    const project = { id: "created-project", name: "Product" };
    const create = vi.fn(async () => project);
    const configure = vi.fn(async () => project);
    const validate = vi.fn(async () => undefined);
    const props = {
      targets: [{ location: "cloud", create }],
      defaultLocation: "cloud",
      allowDingTalkAITable: false,
      labels: projectCreateLabels.en,
      onCreated: vi.fn(),
      onClose: vi.fn(),
      resourceSetup: {
        configure,
        validate,
        executionEnvironments: [],
        executionEnvironmentLoading: state === "loading",
        executionEnvironmentError:
          state === "error" ? "Device discovery failed" : undefined,
      },
    } as unknown as ProjectCreateDialogProps;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let current!: ReturnType<typeof useProjectCreateController>;
    const readySelections: number[][] = [];
    function Harness() {
      current = useProjectCreateController(props);
      if (
        !props.resourceSetup?.executionEnvironmentLoading &&
        !props.resourceSetup?.executionEnvironmentError
      ) {
        readySelections.push([...current.state.executionEnvironmentDeviceIds]);
      }
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Harness)));
      act(() => current.commands.setName("Product"));
      expect(current.state.canSubmit).toBe(true);
      act(() => {
        current.commands.setTemplateDocument(
          builtinCollaborationTemplates()[0].document,
        );
      });
      expect(current.state.canSubmit).toBe(false);
      await act(async () => current.commands.submit());
      expect(validate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(configure).not.toHaveBeenCalled();

      props.resourceSetup!.executionEnvironmentLoading = false;
      props.resourceSetup!.executionEnvironmentError = undefined;
      props.resourceSetup!.executionEnvironments = [
        {
          id: "75",
          device_id: 75,
          device_key: "app-record-75",
          app_device_id: "electron-current",
          name: "Current device",
          kind: "local_device",
          coding_tools: ["codex"],
          owner_type: "user",
          owner_id: "1",
          owner_name: "User",
          updated_at: "2026-11-06T00:00:00Z",
          status: "online",
          is_current_device: true,
        },
      ];
      await act(async () => root.render(createElement(Harness)));
      expect(readySelections.length).toBeGreaterThan(0);
      for (const selection of readySelections) expect(selection).toEqual([75]);
      expect(current.state.executionEnvironmentDeviceIds).toEqual([75]);
      expect(current.state.canSubmit).toBe(true);
      act(() => current.commands.setExecutionEnvironmentDeviceIds([]));
      props.resourceSetup!.executionEnvironments = [
        ...props.resourceSetup!.executionEnvironments!,
      ];
      await act(async () => root.render(createElement(Harness)));
      expect(current.state.executionEnvironmentDeviceIds).toEqual([]);
      act(() => current.commands.setExecutionEnvironmentDeviceIds([75]));
      await act(async () => current.commands.submit());
      expect(create).toHaveBeenCalledOnce();
      expect(configure).toHaveBeenCalledWith(
        project,
        expect.objectContaining({ executionEnvironmentDeviceIds: [75] }),
      );
    } finally {
      act(() => root.unmount());
    }
  },
);
