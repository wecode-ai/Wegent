import { describe, expect, it, vi } from "vitest";
import { createAutomationExecutionCatalogApi } from "./executionCatalog";

describe("execution catalog shared by web and desktop", () => {
  it("offers only online devices and preserves the complete model identity", async () => {
    const responses: Record<string, unknown> = {
      "/v1/cloud-projects/project/execution-environments": {
        items: ["online", "offline", "provisioning", "error"].map((status) => ({
          device_key: status,
          status,
          device_type: "local",
          name: `${status} device`,
        })),
      },
      "/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework":
        {
          data: [
            {
              name: "model",
              displayName: "Team model",
              type: "group",
              namespace: "team",
              resourceUserId: 7,
              config: {
                protocol: "openai-responses",
              },
            },
          ],
        },
      "/v1/runtime-profiles": [],
    };
    const get = vi.fn(async <T>(path: string): Promise<T> => {
      if (!(path in responses)) throw new Error(`Unexpected request ${path}`);
      return responses[path] as T;
    });

    const catalog = await createAutomationExecutionCatalogApi({ get }).load(
      "project",
    );

    expect(catalog.environments).toEqual([
      {
        deviceId: "online",
        label: "online device",
        executionEnvironment: "local",
      },
    ]);
    expect(catalog.models[0]).toEqual({
      name: "model",
      label: "Team model",
      type: "group",
      options: {
        protocol: "openai-responses",
        weworkCloudModelNamespace: "team",
        weworkCloudModelResourceUserId: "7",
        weworkCloudModelUpstreamApiFormat: "openai-responses",
      },
    });
  });
});
