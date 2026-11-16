// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceCatalogPage } from "./ResourceCatalogPage";
import { DeviceDeleteDialog } from "./DeviceDeleteDialog";
import { deviceLastSeenLabel } from "./DeviceLastSeen";
import { canDeleteOfflineDevice } from "./resourceCatalogModel";
import { platformMessages } from "./platformMessages";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationExecutionEnvironment } from "../types";

const device: CollaborationExecutionEnvironment = {
  id: "42",
  device_id: 42,
  device_key: "old-mac",
  name: "MacBook",
  kind: "local_device",
  coding_tools: ["codex"],
  owner_type: "user",
  owner_id: "7",
  owner_name: "Owner",
  status: "offline",
  updated_at: "",
  last_seen_at: "2026-11-06T00:00:00Z",
};
const messages = platformMessages["zh-CN"];
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(
  devices: CollaborationExecutionEnvironment[],
  remove = vi.fn(async () => {}),
) {
  await act(async () => root.render(deviceCatalogPage(devices, remove)));
}
function deviceCatalogPage(
  devices: CollaborationExecutionEnvironment[],
  remove: (device: CollaborationExecutionEnvironment) => Promise<void>,
) {
  return (
    <ResourceCatalogPage
      api={{} as SharedWorkspaceApi}
      domain="cloud"
      kind="devices"
      cloudAccess={{ status: "connected" } as never}
      agents={[]}
      groups={[]}
      environments={devices}
      locale="zh-CN"
      currentUserId={7}
      translate={(_key, fallback) => fallback ?? ""}
      canCreateDevice={false}
      workspaces={[]}
      projects={[]}
      ownerOptions={[]}
      messages={messages}
      onAddToWorkspace={async () => {}}
      onCreateAgent={() => {}}
      onCreateDevice={() => {}}
      onCreateLocalAgent={() => {}}
      onCreateTeam={() => {}}
      onDeleteAgent={async () => {}}
      onDeleteTeam={async () => {}}
      onManageResource={() => {}}
      onDeleteDevice={remove}
    />
  );
}
async function click(id: string) {
  await act(async () =>
    (
      container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement
    ).click(),
  );
}

describe("device cleanup catalog", () => {
  it("shows known workspace names and counts other references in the confirmation", async () => {
    await act(async () =>
      root.render(
        <DeviceDeleteDialog
          device={{ ...device, workspace_ids: ["visible", "hidden"] }}
          workspaceNames={["Product space"]}
          locale="zh-CN"
          messages={messages}
          onDelete={async () => {}}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("Product space");
    expect(container.textContent).toContain("其他 1 个分组");
    expect(container.textContent).toContain("#42");
  });
  it("shows only online registrations and keeps distinct online instances", async () => {
    await render([
      device,
      { ...device, id: "43", device_id: 43, status: "online" },
      { ...device, id: "44", device_id: 44, status: "online" },
    ]);
    expect(
      container.querySelectorAll('[data-testid^="collaboration-devices-row-"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="collaboration-devices-row-42"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="collaboration-devices-row-43"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="collaboration-devices-row-44"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid^="collaboration-devices-delete-"]'),
    ).toBeNull();
  });
  it("cancels without deleting, prevents duplicate submissions and reports reconnect conflicts", async () => {
    const close = vi.fn();
    let reject!: (error: unknown) => void;
    const remove = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    await act(async () =>
      root.render(
        <DeviceDeleteDialog
          device={device}
          workspaceNames={[]}
          locale="zh-CN"
          messages={messages}
          onDelete={remove}
          onClose={close}
        />,
      ),
    );
    await click("collaboration-delete-device-cancel");
    expect(remove).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    await click("collaboration-delete-device-confirm");
    await click("collaboration-delete-device-confirm");
    expect(remove).toHaveBeenCalledExactlyOnceWith(device);
    await act(async () => reject({ status: 409 }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "设备已上线",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

it("formats observed instants consistently across offsets and preserves unknown history", () => {
  const now = Date.parse("2026-11-06T00:10:00Z");
  expect(deviceLastSeenLabel(device, "zh-CN", messages, now).label).toBe(
    "10分钟前",
  );
  expect(
    deviceLastSeenLabel(
      { ...device, last_seen_at: "2026-11-06T08:00:00+08:00" },
      "zh-CN",
      messages,
      now,
    ).label,
  ).toBe("10分钟前");
  expect(
    deviceLastSeenLabel(
      { ...device, last_seen_at: null },
      "zh-CN",
      messages,
      now,
    ).label,
  ).toBe("暂无记录");
  expect(
    deviceLastSeenLabel(
      { ...device, last_seen_at: "invalid" },
      "en",
      platformMessages.en,
      now,
    ).label,
  ).toBe("No record");
});

it("keeps a pending local catalog request alive when a cloud record is deleted", async () => {
  const { useDeviceCatalog } = await import("./useDeviceCatalog");
  let finishLocal!: (items: CollaborationExecutionEnvironment[]) => void;
  const local = new Promise<CollaborationExecutionEnvironment[]>((resolve) => {
    finishLocal = resolve;
  });
  const api = {
    resources: {
      devices: {
        local: () => local,
        cloud: async () => [device],
      },
    },
  } as SharedWorkspaceApi;
  let remove!: (id: string) => void;
  function Harness() {
    const catalog = useDeviceCatalog(api, true);
    remove = catalog.remove;
    return <span>{catalog.items.map((item) => item.id).join(",")}</span>;
  }
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe("42");
  await act(async () => remove("42"));
  await act(async () =>
    finishLocal([
      {
        ...device,
        id: "current",
        device_key: "current",
        is_current_device: true,
      },
    ]),
  );
  expect(container.textContent).toBe("current");
});

it.each(["online", "offline"] as const)(
  "protects the exact current runtime among duplicate registrations while %s",
  async (status) => {
    const { useDeviceCatalog } = await import("./useDeviceCatalog");
    const api = {
      resources: {
        devices: {
          local: async () => [
            {
              ...device,
              id: "local",
              app_device_id: "desktop",
              runtime_instance_id: "current-runtime",
              status: "online",
            },
            {
              ...device,
              id: "local-alias",
              app_device_id: "desktop",
              runtime_instance_id: "current-runtime",
              status: "online",
            },
          ],
          cloud: async () => [
            {
              ...device,
              app_device_id: "desktop",
              runtime_instance_id: "old-runtime",
            },
            {
              ...device,
              id: "43",
              device_id: 43,
              app_device_id: "desktop",
              runtime_instance_id: "current-runtime",
              status,
            },
            { ...device, id: "44", device_id: 44, app_device_id: "desktop" },
          ],
        },
      },
    } as SharedWorkspaceApi;
    let items: CollaborationExecutionEnvironment[] = [];
    function Harness() {
      items = useDeviceCatalog(api, true).items;
      return <span>{items.length}</span>;
    }
    await act(async () => root.render(<Harness />));
    expect(items.map((item) => item.id).sort()).toEqual(["42", "43", "44"]);
    expect(items.find((item) => item.id === "42")?.is_current_device).not.toBe(
      true,
    );
    expect(items.find((item) => item.id === "43")?.is_current_device).toBe(
      true,
    );
    expect(
      canDeleteOfflineDevice(items.find((item) => item.id === "43")!, 7),
    ).toBe(false);
    expect(
      canDeleteOfflineDevice(items.find((item) => item.id === "44")!, 7),
    ).toBe(false);
  },
);

it("protects offline deletion by ownership, current identity and online state", () => {
  expect(canDeleteOfflineDevice(device, 7)).toBe(true);
  for (const protectedDevice of [
    { ...device, status: "online" as const },
    { ...device, is_current_device: true },
    { ...device, owner_id: "8" },
    { ...device, owner_type: "workspace" as const },
    { ...device, is_current_device_candidate: true },
  ])
    expect(canDeleteOfflineDevice(protectedDevice, 7)).toBe(false);
});

it("preserves current-registration protection during identity loss and recovers independently", async () => {
  const { useDeviceCatalog } = await import("./useDeviceCatalog");
  const local = {
    ...device,
    id: "local",
    device_id: 0,
    app_device_id: "desktop",
    is_current_device: true,
    runtime_instance_id: "current-runtime",
  };
  const listLocal = vi
    .fn()
    .mockResolvedValueOnce([local])
    .mockResolvedValueOnce([{ ...local, runtime_instance_id: undefined }])
    .mockResolvedValue([local]);
  const api = {
    resources: {
      devices: {
        local: listLocal,
        cloud: async () => [
          {
            ...device,
            app_device_id: "desktop",
            runtime_instance_id: "old-runtime",
          },
          {
            ...device,
            id: "43",
            device_id: 43,
            app_device_id: "desktop",
            runtime_instance_id: "current-runtime",
          },
          { ...device, id: "44", device_id: 44, device_key: "unrelated" },
        ],
      },
    },
  } as SharedWorkspaceApi;
  let items: CollaborationExecutionEnvironment[] = [];
  let refresh!: () => Promise<void>;
  function Harness() {
    const catalog = useDeviceCatalog(api, true);
    items = catalog.items;
    refresh = catalog.refresh;
    return deviceCatalogPage(items, vi.fn());
  }
  const removable = (id: string) =>
    canDeleteOfflineDevice(items.find((item) => item.id === id)!, 7);
  await act(async () => root.render(<Harness />));
  expect(removable("42")).toBe(true);
  expect(removable("43")).toBe(false);
  await act(async () => refresh());
  expect(removable("42")).toBe(false);
  expect(removable("43")).toBe(false);
  expect(removable("44")).toBe(true);
  await act(async () => refresh());
  expect(removable("42")).toBe(true);
  expect(removable("43")).toBe(false);
  expect(
    container.querySelector('[data-testid="collaboration-devices-row-42"]'),
  ).toBeNull();
});

it("keeps online cloud discovery visible when local identity is pending or fails", async () => {
  const { useDeviceCatalog } = await import("./useDeviceCatalog");
  let reject!: (error: Error) => void;
  const local = new Promise<CollaborationExecutionEnvironment[]>(
    (_resolve, fail) => {
      reject = fail;
    },
  );
  const cloud = {
    ...device,
    status: "online" as const,
    app_device_id: "desktop",
  };
  const api = {
    resources: { devices: { local: () => local, cloud: async () => [cloud] } },
  } as SharedWorkspaceApi;
  let items: CollaborationExecutionEnvironment[] = [];
  function Harness() {
    items = useDeviceCatalog(api, true).items;
    return deviceCatalogPage(items, vi.fn());
  }
  await act(async () => root.render(<Harness />));
  expect(
    container.querySelector('[data-testid="collaboration-devices-row-42"]'),
  ).not.toBeNull();
  expect(canDeleteOfflineDevice(items[0], 7)).toBe(false);
  await act(async () => reject(new Error("Identity unavailable")));
  expect(
    container.querySelector('[data-testid="collaboration-devices-row-42"]'),
  ).not.toBeNull();
  expect(canDeleteOfflineDevice(items[0], 7)).toBe(false);
});
