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
import { useRuntimeConfiguration } from "./context";
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
  it("publishes device binding changes from inline environment settings", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const project = {
      id: "project",
      workspace_id: "workspace",
      project_store: "backend" as const,
      version: 1,
      access_role: "Owner" as const,
    };
    const updated = { ...project, version: 2 };
    const device = {
      id: "runner-1",
      device_id: 1,
      name: "Runner",
      status: "online",
      kind: "local_device",
      owner_type: "user",
      owner_id: "1",
      owner_name: "Owner",
      coding_tools: [],
      project_version: 2,
    };
    const api = {
      automationExecutionCatalog: {
        load: vi.fn(async () => ({
          environments: [],
          models: [],
          runtimeProfiles: [],
        })),
      },
      runtimeProfiles: {
        getProjectDefault: vi.fn(async () => ({ runtimeProfileId: null })),
      },
      projects: {
        get: vi.fn(async () => updated),
        listExecutionEnvironments: vi.fn(async () => []),
        addExecutionEnvironment: vi.fn(async () => device),
      },
      workspaces: { listExecutionEnvironments: vi.fn(async () => [device]) },
      resources: { devices: { cloud: vi.fn(async () => [device]) } },
    } as unknown as SharedWorkspaceApi;
    const onProjectChange = vi.fn();
    function Configure() {
      const open = useRuntimeConfiguration();
      return (
        <button data-testid="open-runtime-settings" onClick={() => open?.()}>
          Configure
        </button>
      );
    }
    await act(async () =>
      root.render(
        <RuntimeConfigurationProvider
          api={api}
          project={project}
          locale="zh-CN"
          onProjectChange={onProjectChange}
        >
          <Configure />
        </RuntimeConfigurationProvider>,
      ),
    );
    const click = async (id: string) =>
      act(async () => {
        container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click();
      });
    await click("open-runtime-settings");
    await click("project-runtime-configure-environments");
    await click("collaboration-project-execution-environment-add");
    await click("collaboration-project-execution-environment-candidate-1");

    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(updated);
  });

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
            project={{
              id: "project",
              workspace_id: "workspace",
              project_store: "backend",
              version: 1,
              access_role: "Owner",
            }}
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
