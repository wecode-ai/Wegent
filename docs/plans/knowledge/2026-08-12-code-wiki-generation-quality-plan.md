---
sidebar_position: 4
---

# Code Wiki 生成质量实施计划

设计见 [`../../specs/knowledge/2026-08-12-code-wiki-generation-quality-design.md`](../../specs/knowledge/2026-08-12-code-wiki-generation-quality-design.md)。

## 1. Prompt 与 skill 分层

1. 为 `wiki_submit` 补齐 structure order、章节页面、内部链接、发布拒绝和 Mermaid correction
   协议的契约测试。
2. 新增 ClaudeCode 专用 `code-wiki-mermaid` skill 及静态契约测试。
3. 精炼 `code-wiki-ghost`：保留稳定生成策略，删除已由 skills/run prompt 定义的命令与模式
   细节，增加安全、结构深度、工程导航和条件式 Mermaid 要求。
4. 在 incremental run prompt 增加同步维护图示的规则。
5. 运行 Ghost、skills 与 prompt 的聚焦后端测试。

## 2. 手动 full rebuild

1. 给 `CodeWikiRunCreate` 增加默认关闭的 `force_full` 字段。
2. 将该字段传到 generation/run-mode 决策；显式 force 必须先于 same-commit skip。
3. 前端手动重新生成显式发送 `force_full: true`；自动路径不变。
4. 覆盖 schema、service、API request forwarding 和前端 API 调用测试。

## 3. 文档遗留收口

1. 在本设计中记录 B3 已由共享 Markdown 渲染覆盖、不迁移旧实现；同步更新主工作区中尚未
   纳入本基线的 2026-08-11 handoff 交接稿。
2. 单列仓库相对图片缺口，说明它需要受鉴权 raw-file 或 KB attachment 设计。
3. 不把普通图片 Lightbox 与 Mermaid 全屏混为同一能力。

## 4. 回归评分

1. 添加可复用 Markdown 评分模板，固定仓库、commit、模型、语言和 prompt 标识。
2. 提供只读采集命令或脚本说明，统计页面结构、Mermaid 和运行元数据；不得写业务数据。
3. 先保存当前 `abtest`、`user-graph-ci` baseline。
4. 合并静态资源后，由操作者同步实际 Ghost 并触发 `force_full`。
5. 采集候选结果，完成人工与客观新旧对照。实际生成依赖目标环境，不作为本地代码测试假装
   完成。

## 5. 验证

```bash
cd backend
uv run pytest \
  tests/services/knowledge/code_wiki/test_code_wiki_ghost.py \
  tests/services/knowledge/code_wiki/test_code_wiki_skills.py \
  tests/services/knowledge/code_wiki/test_prompts.py \
  tests/services/knowledge/code_wiki/test_run_mode.py \
  tests/services/knowledge/code_wiki/test_generation.py \
  tests/services/knowledge/code_wiki/test_runner.py \
  tests/api/test_knowledge_code_wiki.py

pnpm --dir frontend test -- --runInBand \
  src/__tests__/apis/code-wiki.test.ts \
  src/__tests__/features/knowledge/code-wiki/regenerate-button-state.test.tsx

git diff --check
```

真实生成回归完成后，报告还必须列出执行模型、commit、生成 ID、失败或 publish refusal、耗时与
评分差异，不能只展示更好看的页面截图。

## English Version

### 1. Prompt and skill separation

1. Add contracts for structure order, section pages, links, publish refusal, and diagram correction.
2. Add and test the ClaudeCode-only `code-wiki-mermaid` skill.
3. Keep stable policy in the Ghost; remove command/mode duplication and add security, depth,
   engineering-navigation, and conditional-diagram requirements.
4. Require incremental updates to synchronize affected diagrams.
5. Run focused Ghost, skill, and prompt tests.

### 2. Manual full rebuild

1. Add a default-false `force_full` request field.
2. Forward it through generation and mode selection before same-commit skip.
3. Send `force_full: true` only from the frontend manual regeneration action.
4. Test schema defaults, service behavior, API forwarding, and the frontend request.

### 3. Rendering handoff closure

Record that shared Markdown rendering covers B3 and no old component migration is needed. Keep
ordinary-image lightbox and Mermaid fullscreen behavior distinct. Track repository-relative images
as a separate authenticated-transport decision. The untracked 2026-08-11 main-workspace handoff
draft is updated separately because it is absent from this branch baseline.

### 4. Regression scorecard

Add a reusable bilingual scorecard that fixes repository, commit, model, language, and prompt ID;
provides read-only structure and run-metadata queries; preserves the `abtest` and `user-graph-ci`
baselines; and records the manually triggered candidate results. Real environment generation is a
manual follow-up, not something local tests can claim to complete.

### 5. Verification

Run the backend and frontend commands listed in the Chinese section, then `git diff --check`.
The real-generation report must include model, commit, generation ID, failures/refusals, reliable
duration, and score differences rather than only screenshots.
