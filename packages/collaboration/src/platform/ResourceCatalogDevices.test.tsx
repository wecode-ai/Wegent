// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceCatalogPage } from "./ResourceCatalogPage";
import { DeviceDeleteDialog } from "./DeviceDeleteDialog";
import { deviceLastSeenLabel } from "./DeviceLastSeen";
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
  await act(async () =>
    root.render(
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
      />,
    ),
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
    expect(container.textContent).toContain("其他 1 个空间");
    expect(container.textContent).toContain("#42");
  });
  it("offers deletion only for owned offline registrations and keeps equal names distinct", async () => {
    await render([
      device,
      { ...device, id: "43", device_id: 43, status: "online" },
      { ...device, id: "44", device_id: 44, is_current_device: true },
      { ...device, id: "45", device_id: 45, owner_id: "8" },
      { ...device, id: "46", device_id: 46, owner_type: "workspace" },
    ]);
    expect(
      container.querySelectorAll(
        '[data-testid^="collaboration-devices-delete-"]',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid^="collaboration-devices-row-"]'),
    ).toHaveLength(5);
    expect(container.textContent).toContain("#42");
    expect(
      container.querySelector(
        '[data-testid="collaboration-device-last-seen-43"]',
      )?.textContent,
    ).toBe("当前在线");
  });
  it("cancels without deleting and submits only the selected record once", async () => {
    let done!: () => void;
    const remove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    await render([device, { ...device, id: "43", device_id: 43 }], remove);
    await click("collaboration-devices-delete-42");
    await click("collaboration-delete-device-cancel");
    expect(remove).not.toHaveBeenCalled();
    await click("collaboration-devices-delete-43");
    await click("collaboration-delete-device-confirm");
    await click("collaboration-delete-device-confirm");
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ device_id: 43 }),
    );
    await act(async () => done());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("keeps the record and shows a useful error when the device reconnects", async () => {
    await render(
      [device],
      vi.fn(async () => {
        throw { status: 409 };
      }),
    );
    await click("collaboration-devices-delete-42");
    await click("collaboration-delete-device-confirm");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "设备已上线",
    );
    expect(
      container.querySelector('[data-testid="collaboration-devices-row-42"]'),
    ).not.toBeNull();
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

it("preserves separate registrations sharing an app identity and marks only the active runtime current", async () => {
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
            status: "online",
          },
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
  expect(items.map((item) => item.id).sort()).toEqual(["42", "43"]);
  expect(items.find((item) => item.id === "42")?.is_current_device).not.toBe(
    true,
  );
  expect(items.find((item) => item.id === "43")?.is_current_device).toBe(true);
});
