// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SharedWorkspaceApi,
  WorkspaceProjectManagerRun,
} from "../ports/SharedWorkspaceApi";
import type { CollaborationAgent, CollaborationProject } from "../types";
import { ProjectAiBoardAssistant } from "./ProjectAiBoardAssistant";

const project = {
  id: "project-1",
  title: "Project",
  project_store: "local",
  access_role: "Owner",
} as CollaborationProject;

const agent = {
  id: "agent-1",
  agent_id: "current-device-agent",
  status: "active",
} as CollaborationAgent;

const existingRun = {
  id: "run-1",
  projectId: project.id,
  trigger: "manual",
  status: "succeeded",
  instruction: "Initial question",
  response: "Initial answer",
  runtimeDeviceId: "device-1",
  runtimeTaskId: "task-1",
} as WorkspaceProjectManagerRun;

describe("ProjectAiBoardAssistant", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("continues the current Runtime session and starts a new task only after New chat", async () => {
    const run = vi.fn().mockResolvedValue({
      ...existingRun,
      id: "run-2",
      runtimeTaskId: "task-2",
    });
    const projectManager = {
      get: vi.fn().mockResolvedValue({
        projectId: project.id,
        version: 1,
        enabled: true,
        agentId: agent.id,
        prompt: "Manage the project",
        triggers: [],
      }),
      save: vi.fn(),
      run,
      listRuns: vi.fn().mockResolvedValue([existingRun]),
      getRun: vi.fn().mockResolvedValue(existingRun),
      decide: vi.fn(),
    };
    const continueConversation = vi.fn().mockResolvedValue(undefined);
    let composerValue = "";
    let changeComposer = (_value: string) => undefined;

    await act(async () => {
      root.render(
        <ProjectAiBoardAssistant
          api={{ projectManager } as unknown as SharedWorkspaceApi}
          project={project}
          issues={[]}
          agents={[agent]}
          locale="en"
          onOpenSettings={() => undefined}
          onOpenIssue={() => undefined}
          onContinueConversation={continueConversation}
          renderConversation={({ runs }) => (
            <div data-testid="manager-session">{runs[0]?.id}</div>
          )}
          renderComposer={({ value, onChange, onSubmit }) => {
            composerValue = value;
            changeComposer = onChange;
            return (
              <button
                type="button"
                data-testid="manager-send"
                onClick={() => onSubmit(composerValue)}
              >
                Send
              </button>
            );
          }}
        />,
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="project-ai-expand"]')
        ?.click();
    });
    await waitForElement(container, '[data-testid="manager-session"]');

    await act(async () => {
      changeComposer("Follow up");
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="manager-send"]')
        ?.click();
    });
    await waitForCall(continueConversation);
    expect(continueConversation).toHaveBeenCalledWith(
      project,
      existingRun,
      "Follow up",
      undefined,
    );
    expect(run).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="project-ai-new-conversation"]',
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="manager-session"]'),
    ).toBeNull();

    await act(async () => {
      changeComposer("Start over");
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="manager-send"]')
        ?.click();
    });
    await waitForCall(run);
    expect(run).toHaveBeenCalledWith(project.id, "Start over", undefined);
  });

  it("stops the active Runtime conversation from the composer", async () => {
    const activeRun = {
      ...existingRun,
      status: "running",
    } as WorkspaceProjectManagerRun;
    const projectManager = {
      get: vi.fn().mockResolvedValue({
        projectId: project.id,
        version: 1,
        enabled: true,
        agentId: agent.id,
        prompt: "Manage the project",
        triggers: [],
      }),
      save: vi.fn(),
      run: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([activeRun]),
      getRun: vi.fn().mockResolvedValue(activeRun),
      decide: vi.fn(),
    };
    const stopConversation = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <ProjectAiBoardAssistant
          api={{ projectManager } as unknown as SharedWorkspaceApi}
          project={project}
          issues={[]}
          agents={[agent]}
          locale="en"
          onOpenSettings={() => undefined}
          onOpenIssue={() => undefined}
          onStopConversation={stopConversation}
          renderComposer={({ running, onStop }) => (
            <button
              type="button"
              data-testid="manager-stop"
              disabled={!running}
              onClick={() => void onStop()}
            >
              Stop
            </button>
          )}
        />,
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="project-ai-expand"]')
        ?.click();
    });
    await waitForElement(container, '[data-testid="manager-stop"]');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="manager-stop"]')
        ?.click();
    });
    await waitForCall(stopConversation);

    expect(stopConversation).toHaveBeenCalledWith(project, activeRun);
  });
});

async function waitForElement(container: HTMLElement, selector: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const element = container.querySelector(selector);
    if (element) return element;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Element not found: ${selector}`);
}

async function waitForCall(callback: ReturnType<typeof vi.fn>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (callback.mock.calls.length > 0) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("Callback was not called");
}
