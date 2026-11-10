// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectCreateLabels } from "./labels";
import { useProjectCreateController } from "./useProjectCreateController";
import type { ProjectCreateDialogProps, ProjectCreateLocation } from "./types";
import type { CollaborationTemplate } from "../templates/types";
import type { CollaborationProject } from "../types";

const template: CollaborationTemplate = {
  apiVersion: "agent.wecode.io/v1",
  kind: "Template",
  metadata: { name: "review", namespace: "default" },
  spec: {
    category: "collaboration",
    displayName: "Review",
    description: "",
    version: "1",
    resources: {
      collaboration: {
        project: { name: "Review", description: "" },
        agents: [
          {
            key: "reviewer",
            name: "Reviewer",
            runtime: "codex",
            systemPrompt: "",
            capabilityDescription: "",
          },
        ],
        groups: [],
      },
    },
  },
};

let root: Root;
let controller: ReturnType<typeof useProjectCreateController>;
function Harness(props: ProjectCreateDialogProps) {
  controller = useProjectCreateController(props);
  return null;
}
const render = (props: ProjectCreateDialogProps) =>
  act(async () => root.render(createElement(Harness, props)));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

function fixture(location: ProjectCreateLocation, initialTemplate = template) {
  const project: CollaborationProject = {
    id: "created-project",
    public_id: "created-project",
    project_key: "review",
    name: "Review",
    description: "",
    project_store: location === "local" ? "local" : "backend",
    task_provider: "local",
    provider_config: {},
    created_by_user_id: 1,
    status: "active",
    tags: [],
    version: 1,
    created_at: "",
    updated_at: "",
  };
  const create = vi.fn(async () => project);
  const configure = vi.fn(async () => project);
  const props = {
    targets: [{ location, create }],
    defaultLocation: location,
    initialTemplate,
    allowDingTalkAITable: false,
    labels: projectCreateLabels.en,
    resourceSetup: {
      location,
      currentUser: { id: 1, name: "Owner" },
      members: [],
      agents: [],
      groups: [],
      executionEnvironments: [],
      executionEnvironmentLoading: true,
      configure,
    },
    onClose: vi.fn(),
    onCreated: vi.fn(),
  } satisfies ProjectCreateDialogProps;
  return { props, project, create, configure };
}

it("waits for cloud template device discovery before capturing the authorization selection", async () => {
  const { props, project, create, configure } = fixture("cloud");
  await render(props);
  expect(controller.state.canSubmit).toBe(false);
  await act(async () => controller.commands.submit());
  expect(create).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
  await render({
    ...props,
    resourceSetup: {
      ...props.resourceSetup,
      executionEnvironmentLoading: false,
      executionEnvironments: [
        {
          id: "42",
          device_id: 42,
          device_key: "app-record-42",
          app_device_id: "current-app",
          name: "Current App",
          kind: "local_device",
          coding_tools: ["codex"],
          owner_type: "user",
          owner_id: "1",
          owner_name: "Owner",
          status: "online",
          is_current_device: true,
          updated_at: "",
        },
      ],
    },
  });
  expect(controller.state.canSubmit).toBe(true);
  await act(async () => controller.commands.submit());
  expect(create).toHaveBeenCalledTimes(1);
  expect(configure).toHaveBeenCalledWith(
    project,
    expect.objectContaining({
      executionEnvironmentDeviceIds: [42],
    }),
  );
  expect(props.onCreated).toHaveBeenCalledWith(project, "cloud");
});

it.each(["cloud", "local"] as const)(
  "keeps unrelated %s project creation independent of cloud device discovery",
  async (location) => {
    const independent = structuredClone(template);
    if (location === "cloud")
      independent.spec.resources.collaboration.agents = [];
    const { props, create } = fixture(location, independent);
    await render(props);
    expect(controller.state.canSubmit).toBe(true);
    await act(async () => controller.commands.submit());
    expect(create).toHaveBeenCalledTimes(1);
  },
);
