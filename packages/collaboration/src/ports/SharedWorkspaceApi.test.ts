// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  SharedWorkspaceApi,
  SharedWorkspaceHostPort,
  SharedWorkspaceMyWorkApi,
  WebWorkspaceHostPort,
  WeworkWorkspaceRuntimePort,
} from "./SharedWorkspaceApi";

describe("SharedWorkspaceApi boundaries", () => {
  it("keeps every cloud capability in one domain-shaped API", () => {
    expectTypeOf<keyof SharedWorkspaceApi>().toEqualTypeOf<
      | "projects"
      | "myWork"
      | "issues"
      | "comments"
      | "attachments"
      | "collaborators"
      | "taskBindings"
      | "workflowPlans"
      | "members"
      | "files"
      | "deliveries"
      | "executions"
      | "automations"
      | "incomingHooks"
      | "automationExecutionCatalog"
      | "runtimeProfiles"
      | "agents"
    >();

    const domains = [
      "projects",
      "myWork",
      "issues",
      "comments",
      "attachments",
      "collaborators",
      "taskBindings",
      "workflowPlans",
      "members",
      "files",
      "deliveries",
      "executions",
      "automations",
      "incomingHooks",
      "automationExecutionCatalog",
      "runtimeProfiles",
      "agents",
    ];
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("does not leak desktop runtime methods into the cloud API", () => {
    expectTypeOf<SharedWorkspaceApi>().not.toHaveProperty("trackProjectTask");
    expectTypeOf<SharedWorkspaceApi>().not.toHaveProperty("claimNextExecution");
    expectTypeOf<WeworkWorkspaceRuntimePort>().toHaveProperty(
      "trackProjectTask",
    );
    expectTypeOf<WeworkWorkspaceRuntimePort>().toHaveProperty(
      "claimNextExecution",
    );
  });

  it("keeps My Work behind an optional host-provided port", () => {
    expectTypeOf<SharedWorkspaceApi["myWork"]>().toEqualTypeOf<
      SharedWorkspaceMyWorkApi | undefined
    >();
    expectTypeOf<SharedWorkspaceApi["projects"]>().not.toHaveProperty(
      "listMyWork",
    );
  });

  it("keeps host effects outside the cloud API", () => {
    expectTypeOf<SharedWorkspaceApi>().not.toHaveProperty("navigate");
    expectTypeOf<WebWorkspaceHostPort>().toHaveProperty("navigate");
    expectTypeOf<SharedWorkspaceHostPort>().toHaveProperty("saveFile");
  });
});
