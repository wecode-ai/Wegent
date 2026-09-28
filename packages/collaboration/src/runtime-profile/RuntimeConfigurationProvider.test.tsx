// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RuntimeConfigurationProvider } from "./RuntimeConfigurationProvider";
import { ExecutionConfigurationNotice } from "./ExecutionConfigurationNotice";
import type {
  SharedWorkspaceApi,
  WorkspaceRuntimeProfile,
} from "../ports/SharedWorkspaceApi";

const profile: WorkspaceRuntimeProfile = {
  id: "runtime",
  name: "My Runtime",
  executionEnvironment: "cloud",
  executionDeviceId: "device",
  model: "model",
  modelType: null,
  modelOptions: {},
  version: 1,
  status: "active",
};
let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("inline runtime configuration", () => {
  it.each(["success", "denied", "save-error"])(
    "configures a blocked execution without changing defaults: %s",
    async (scenario) => {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      const execution = {
        id: 627,
        loop_item_id: "child",
        version: 3,
        can_select_runtime: scenario !== "denied",
      };
      const selectExecution = vi
        .fn()
        .mockResolvedValue({ ...execution, status: "queued" });
      if (scenario === "save-error")
        selectExecution.mockRejectedValueOnce(new Error("Save failed"));
      const setProjectDefault = vi.fn();
      const getProjectDefault = vi.fn();
      const api = {
        executions: { list: vi.fn().mockResolvedValue([execution]) },
        automationExecutionCatalog: {
          load: vi.fn().mockResolvedValue({
            environments: [],
            models: [],
            runtimeProfiles: [profile],
            plugins: [],
          }),
        },
        runtimeProfiles: {
          selectExecution,
          setProjectDefault,
          getProjectDefault,
        },
      } as unknown as SharedWorkspaceApi;
      await act(async () =>
        root.render(
          <RuntimeConfigurationProvider
            api={api}
            project={{ id: "project", access_role: "Owner" }}
            locale="zh-CN"
          >
            <ExecutionConfigurationNotice
              issue={{
                id: "child",
                execution_id: 627,
                execution_state: "waiting_runtime",
                assignee_agent_id: "codex",
              }}
              translate={(key) => key}
            />
          </RuntimeConfigurationProvider>,
        ),
      );
      const get = (id: string) =>
        container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      await act(async () => get("execution-configure-child").click());
      expect(api.executions.list).toHaveBeenCalledWith("project", {
        agentId: "codex",
        status: "waiting_runtime",
      });
      if (scenario === "denied") {
        expect(get("runtime-configuration-dialog")).toBeNull();
        expect(container.textContent).toContain("需要由本次执行的所属用户配置");
        expect(selectExecution).not.toHaveBeenCalled();
        return;
      }
      await act(async () => {
        const select = get("project-runtime-profile") as HTMLSelectElement;
        select.value = profile.id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => get("project-runtime-save").click());
      if (scenario === "save-error") {
        expect(container.textContent).toContain("Save failed");
        expect(get("execution-configure-child")).not.toBeNull();
        await act(async () => get("project-runtime-save").click());
      }
      expect(selectExecution).toHaveBeenLastCalledWith(
        "project",
        627,
        profile.id,
        3,
      );
      expect(getProjectDefault).not.toHaveBeenCalled();
      expect(setProjectDefault).not.toHaveBeenCalled();
      expect(get("execution-configure-child")).toBeNull();
      expect((get("project-runtime-save") as HTMLButtonElement).disabled).toBe(
        true,
      );
    },
  );
});
