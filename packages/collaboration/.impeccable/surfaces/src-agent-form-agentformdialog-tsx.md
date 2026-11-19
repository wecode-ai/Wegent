---
sidebar_position: 0
version: 1
slug: "src-agent-form-agentformdialog-tsx"
primary_target: "src/agent-form/AgentFormDialog.tsx"
related_targets: []
---

# 智能体配置 / Agent configuration

Mode: Operate. Extend the established project-settings surface and neutral Wework world. Audience: project administrators configuring and maintaining an Agent. The owner supplied a real editor screenshot and explicitly found it incomprehensible.

THESIS: 一页形成“它做什么、具备哪些工具、在哪里用什么模型运行”的连续理解。A continuous configuration page connects responsibilities, tools and runtime instead of making the administrator reconstruct that relationship.

OWN-WORLD: Inherit Wework DESIGN.md: system typography, semantic sizes, grayscale surfaces, restrained separators, inverse-neutral save, blue only for focus/links. Preserve existing capabilities, permission boundaries, drafts and explicit saving.

STORY: Name the Agent and describe its responsibilities. Read the current tools and runtime configuration as named summaries; expand either independently. Changing tools or runtime retains the responsibility draft. Review and save once; configuration never starts a task.

FIRST VIEWPORT: Header states the job. Name and responsibilities lead the scrollable body. Two independently expandable sections follow: Tools and skills; How it runs. The runtime summary labels Environment and Model separately. The footer holds Cancel and Save. No tab switching or footer navigation is needed to understand the Agent. Signature interaction: current configuration stays recognizable while either inline section expands.

FORM: Extend the already approved inline-maintenance structure from project settings, seed:be2beafbfa1d7230. This is a component extension within that settled surface, not a new visual-world or concept-selection round. Code-led build.

FINISH: Verify creation and editing, ordinary and system-managed Agents, follow-device and fixed tools, model/device recovery, legacy configuration preservation, validation, keyboard/focus, long text, both themes and constrained widths in official isolated ai:verify. Preserve stable interactive test IDs where the corresponding action remains; remove obsolete basic-tab behavior with evidenced E2E updates. Complete the single remaining independent full settings A/B review after the redesign; subsequent verification is focused on concrete findings only.
