import type {
  SharedWorkspaceApi,
  SharedWorkspaceAutomationsApi,
  SharedWorkspaceIncomingHooksApi,
  SharedWorkspaceProjectsApi,
  WorkspaceAutomationRule,
  WorkspaceAutomationRun,
  WorkspaceIncomingHook,
} from "../ports/SharedWorkspaceApi";
import type {
  AutomationBackendInput,
  AutomationBackendRule,
  AutomationBackendRun,
  AutomationEventSourceCatalogItem,
  AutomationProject,
  ProjectWorkflowDefinition,
} from "../automation";
import type { AutomationIncomingHook } from "./AutomationRulesView.jsx";

function automationRule(rule: WorkspaceAutomationRule): AutomationBackendRule {
  return rule as unknown as AutomationBackendRule;
}

function automationRun(run: WorkspaceAutomationRun): AutomationBackendRun {
  return run as unknown as AutomationBackendRun;
}

function incomingHook(hook: WorkspaceIncomingHook): AutomationIncomingHook {
  return hook as unknown as AutomationIncomingHook;
}

export interface SharedWorkspaceAutomationApi {
  projects: Pick<SharedWorkspaceProjectsApi, "update">;
  automations?: Pick<
    SharedWorkspaceAutomationsApi,
    | "list"
    | "create"
    | "migrateWorkflow"
    | "update"
    | "remove"
    | "runNow"
    | "listRuns"
  >;
  incomingHooks?: Pick<
    SharedWorkspaceIncomingHooksApi,
    "catalog" | "list" | "create" | "update" | "rotate" | "remove"
  >;
}

export function createSharedWorkspaceAutomationPorts<
  P extends AutomationProject,
>(api: SharedWorkspaceAutomationApi | SharedWorkspaceApi) {
  const automations = api.automations;
  const incomingHooks = api.incomingHooks;

  return {
    automationApi: automations
      ? {
          async list(projectId: string) {
            return (await automations.list(projectId)).map(automationRule);
          },
          async create(projectId: string, input: AutomationBackendInput) {
            return automationRule(
              await automations.create(
                projectId,
                input as unknown as Record<string, unknown>,
              ),
            );
          },
          async migrateWorkflow(
            projectId: string,
            input: {
              projectVersion: number;
              automation: AutomationBackendInput;
              workflowDefinition: ProjectWorkflowDefinition;
            },
          ) {
            const result = await automations.migrateWorkflow(
              projectId,
              input as unknown as Record<string, unknown>,
            );
            return {
              automation: automationRule(result.automation),
              projectVersion: result.projectVersion,
              workflowAutomationId: result.automation.id,
            };
          },
          async update(
            projectId: string,
            automationId: string,
            input: Partial<AutomationBackendInput> & { version: number },
          ) {
            return automationRule(
              await automations.update(
                projectId,
                automationId,
                input as unknown as Record<string, unknown> & {
                  version: number;
                },
              ),
            );
          },
          remove: automations.remove,
          async runNow(projectId: string, automationId: string) {
            return automationRun(
              await automations.runNow(projectId, automationId),
            );
          },
          async listRuns(projectId: string, automationId: string) {
            return (await automations.listRuns(projectId, automationId)).map(
              automationRun,
            );
          },
        }
      : undefined,
    projectApi: {
      async clearLegacyWorkflow(
        project: P,
        workflowDefinition: ProjectWorkflowDefinition,
      ) {
        return (await api.projects.update(String(project.id), {
          version: project.version,
          workflowDefinition: workflowDefinition as unknown as Record<
            string,
            unknown
          >,
        })) as unknown as P;
      },
    },
    incomingHooksApi: incomingHooks
      ? {
          async catalog() {
            return (await incomingHooks.catalog()) as unknown as AutomationEventSourceCatalogItem[];
          },
          async list(projectId: string) {
            return (await incomingHooks.list(projectId)).map(incomingHook);
          },
          async create(
            projectId: string,
            input: Parameters<typeof incomingHooks.create>[1],
          ) {
            return incomingHook(await incomingHooks.create(projectId, input));
          },
          async update(
            projectId: string,
            hookId: string,
            input: Parameters<typeof incomingHooks.update>[2],
          ) {
            return incomingHook(
              await incomingHooks.update(projectId, hookId, input),
            );
          },
          async rotate(projectId: string, hookId: string) {
            return incomingHook(await incomingHooks.rotate(projectId, hookId));
          },
          remove: incomingHooks.remove,
        }
      : undefined,
  };
}
