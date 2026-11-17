---
sidebar_position: 0
---

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

本次设置界面的主要使用者是项目管理者，目标是快速配置并持续维护整个协作项目。此优先级由用户确认。

Project administrators are the primary audience for these settings. Their confirmed job is to configure a collaboration project quickly and maintain it over time.

## Product Purpose

将项目属性、人的访问权限、智能体与协作小组、执行环境和自动处理配置组织为连贯的管理体验。

Provide a coherent management experience for project properties, human access, Agents and collaboration groups, execution environments, and automation.

## Operating Context

界面由共享 React 模块实现，Wework 在 Electron 中承载；同一模块也服务 Web。项目数据位置、代码目录位置和执行设备位置是不同维度。本地项目和云端项目保留相同的协作语义。

Shared React surfaces run in Wework's Electron workbench and on the web. Project storage, code workspaces, and execution devices are separate dimensions. Local and cloud projects retain the same collaboration semantics.

## Capabilities and Constraints

保留现有功能、权限边界与乐观锁。配置操作本身不应启动任务。管理者可直接进入任一配置区域，不要求遵循向导顺序。复杂配置显式保存，普通权限与属性按现有行为保存。

Preserve existing capabilities, permission boundaries, and optimistic locking. Configuration alone does not start work. Administrators can enter any settings area directly. Complex configuration uses explicit saving; ordinary permissions and properties follow their established save behavior.

## Brand Commitments

产品名称为 Wework。视觉与交互遵循 [Wework DESIGN.md](../../wework/DESIGN.md)，使用现有中性桌面工作台体系及语义组件。

Keep the Wework identity and the existing neutral desktop workbench system defined by Wework DESIGN.md.

## Evidence on Hand

现有实现位于 `src/project-manage/`、`src/platform/`、`src/agent-form/` 和 `src/templates/`。用户操作文档位于 `docs/zh/wework/projects.md` 与对应英文主题；真实界面通过隔离 `ai:verify` Electron 获取，截图不提交。

The existing implementation, bilingual project manuals, and isolated ai:verify Electron captures provide evidence. Verification screenshots remain local.

## Product Principles

- 同一项目的配置工作可以连续进行，跨页不丢草稿。 / Keep configuration continuous within a project.
- 区分人的访问权限与 AI 的执行、协作配置。 / Distinguish human access from AI execution and coordination.
- 执行环境属于 AI 配置，与智能体和协作小组同组；自动处理也可分配给人，保留在项目设置。 / Group execution environments with Agents and collaboration groups under AI configuration; automation also routes work to people and stays in project settings.
- 保存结果真实明确；刷新失败可以重试读取，不重复提交。 / Report writes truthfully and retry failed reads without repeating writes.
- 可选能力按需展开，不限制用户已有工作方式。 / Reveal optional capability without prescribing a workflow.

## Accessibility & Inclusion

遵循既有键盘、焦点、语义标签、文字对比度与响应式要求；颜色不能是唯一的状态提示。

Preserve keyboard access, visible focus, semantic labels, readable contrast, and responsive behavior. Color must not be the only state cue.
