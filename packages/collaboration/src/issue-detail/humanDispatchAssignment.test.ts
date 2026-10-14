import { describe, expect, it } from "vitest";
import { humanDispatchAssignment } from "./humanDispatchAssignment";

function managerMessage(overrides: Partial<Record<string, unknown>> = {}): {
  metadata: Record<string, unknown>;
} {
  return {
    metadata: {
      activity_type: "manager_assignment",
      dispatch_id: "dispatch-1",
      coordination_round_id: "round-1",
      dispatch_assignments: [
        {
          assignee_type: "human",
          human_assignment_id: "human-assignment-1",
          human_user_id: 42,
          assignment_id: "assignment-1",
          task_title: "核对发布清单",
          workflow_stage_id: "review",
        },
      ],
      ...overrides,
    },
  };
}

describe("humanDispatchAssignment", () => {
  it("does not reuse a human assignment after a newer round assigns another member", () => {
    expect(
      humanDispatchAssignment(
        [managerMessage(), managerMessage({ dispatch_assignments: [] })],
        "42",
      ),
    ).toBeNull();
  });
  it("reads the work item a manager assigned to the current member", () => {
    expect(
      humanDispatchAssignment(
        [
          { metadata: { activity_type: "manager_status_comment" } },
          managerMessage(),
        ],
        "42",
      ),
    ).toEqual({
      humanAssignmentId: "human-assignment-1",
      dispatchId: "dispatch-1",
      roundId: "round-1",
      assignmentId: "assignment-1",
      taskTitle: "核对发布清单",
      workflowStageId: "review",
    });
  });

  it("matches the current member against a number or string user id", () => {
    const messages = [managerMessage()];
    expect(humanDispatchAssignment(messages, 42)).not.toBeNull();
    expect(humanDispatchAssignment(messages, "42")).not.toBeNull();
  });

  it("matches explicit identities of the same local member while excluding other people", () => {
    expect(humanDispatchAssignment([managerMessage()], [0, 42])).not.toBeNull();
    expect(humanDispatchAssignment([managerMessage()], [0, 7])).toBeNull();
    expect(humanDispatchAssignment([managerMessage()], [])).toBeNull();
  });

  it("ignores assignments that belong to another member", () => {
    expect(humanDispatchAssignment([managerMessage()], "7")).toBeNull();
  });

  it("keeps the latest round when a member is assigned more than once", () => {
    const older = managerMessage();
    const newer = managerMessage({
      coordination_round_id: "round-2",
      dispatch_assignments: [
        {
          assignee_type: "human",
          human_assignment_id: "human-assignment-2",
          human_user_id: 42,
          assignment_id: "assignment-2",
          task_title: "复核修复结果",
        },
      ],
    });
    expect(humanDispatchAssignment([older, newer], "42")).toMatchObject({
      humanAssignmentId: "human-assignment-2",
      roundId: "round-2",
      workflowStageId: null,
    });
  });

  it("returns null when the manager assigned the work to a robot", () => {
    const messages = [
      managerMessage({
        dispatch_assignments: [
          {
            assignee_type: "agent",
            agent_name: "执行智能体",
            assignment_id: "assignment-1",
            task_title: "核对发布清单",
          },
        ],
      }),
    ];
    expect(humanDispatchAssignment(messages, "42")).toBeNull();
  });

  it("ignores manager activity that carries no dispatch binding", () => {
    const messages = [
      {
        metadata: {
          dispatch_role: "manager",
          coordination_round_id: "round-1",
          dispatch_assignments: [
            {
              assignee_type: "human",
              human_assignment_id: "PROJ-5",
              assignee_id: "42",
              assignment_id: "assignment-1",
              task_title: "核对发布清单",
            },
          ],
        },
      },
    ];
    expect(humanDispatchAssignment(messages, "42")).toBeNull();
  });

  it("returns null without an authenticated member", () => {
    expect(humanDispatchAssignment([managerMessage()], null)).toBeNull();
    expect(humanDispatchAssignment([managerMessage()], undefined)).toBeNull();
  });
});
