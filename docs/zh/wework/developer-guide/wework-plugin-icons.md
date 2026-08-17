---
sidebar_position: 23
---

# Wework 插件图标指南（wework-plugins）

面向 [wework-plugins](https://github.com/wecode-ai/wework-plugins)（及企业内部插件仓）维护者：如何在插件包里提供 `logo` / `logoDark`，保证亮色与暗色 UI 都可读。

Wework 客户端**只做通用逻辑**：按主题选图、图标槽白底/黑底、无图时用中性默认标。品牌亮暗图必须由插件包提供，不要依赖客户端按插件名猜图标。

## 1. 要改哪里

每个插件目录（例如 `plugins/dingtalk/`）：

```text
plugins/<slug>/
├── .codex-plugin/
│   └── plugin.json          # interface.logo / logoDark / composerIcon
└── assets/
    ├── app-icon.svg         # 或 logo.png：亮色/通用图
    └── app-icon-dark.svg    # 可选：暗色专用图
```

在 `.codex-plugin/plugin.json` 的 `interface` 中声明路径（相对插件根目录）：

```json
{
  "name": "dingtalk",
  "version": "1.0.0",
  "description": "…",
  "interface": {
    "displayName": "钉钉",
    "shortDescription": "…",
    "logo": "./assets/app-icon.svg",
    "composerIcon": "./assets/app-icon.svg",
    "logoDark": "./assets/app-icon-dark.svg"
  }
}
```

| 字段 | 必填 | 用途 |
| --- | --- | --- |
| `logo` | 强烈建议 | 市场卡片、已安装列表、详情等主图标（亮色主题优先） |
| `composerIcon` | 可选 | 对话输入区小图标；省略时回退到 `logo` |
| `logoDark` | 按需 | 暗色主题优先使用；省略时暗色回退到 `logo` / `composerIcon` |

支持的相对资源类型：`.png` / `.jpg` / `.jpeg` / `.svg` / `.webp`。

## 2. 什么时候必须提供 `logoDark`

| 情况 | 是否需要 `logoDark` |
| --- | --- |
| 彩色品牌标（钉钉蓝、飞书多色等），亮暗底上都清楚 | **可不提供**；同一文件写在 `logo`（与 `composerIcon`）即可 |
| 接近纯黑 / 深灰的单色标（如经典 GitHub Octocat） | **必须提供**浅色变体作为 `logoDark` |
| 白描边 / 浅色标，主要靠透明底 | 检查亮色主题：若发白看不清，应把「深色版」放进 `logo`，必要时再为暗色提供浅色 `logoDark` |
| 完全没有 `logo` | Wework 会显示中性默认标；官方插件上架前应补齐 `logo` |

经验法则：在 Wework **亮色**与**暗色**下分别打开市场卡片、Slash `/` 菜单、输入栏插件预览，图标都应一眼可辨。任一主题发虚，就补对应资源，而不是改客户端。

## 3. wework-plugins 改造步骤

1. 在 `plugins/<slug>/assets/` 放入亮色（或通用）图标。
2. 若暗色不可读，再放暗色专用文件（建议命名 `*-dark.svg` / `logo-dark.png`）。
3. 更新 `plugin.json` 的 `interface.logo`、`composerIcon`、`logoDark`（路径以 `./assets/` 开头）。
4.  bump 插件 `version`（SemVer）。
5. 若该 slug 已在 Wegent 市场发布：用现有官方发布流程重新发布 / seed（见 [插件市场开发指南](./wework-plugin-marketplace-dev.md)），再在本机更新或重装插件验证。

公开仓 seed 的 slug 与 Wegent `backend/scripts/seed_wework_public_plugins.py` 保持一致；企业仓插件用对应的 `publish_official_plugin.py --visibility workspace`（或你们现有流程）。

## 4. 客户端如何消费（便于联调）

暗色主题选型顺序：`logoDark` → `logo` → `composerIcon`。  
亮色主题：`logo` → `composerIcon`。  
都没有：中性默认图标。

Composer 暗色主题下，仅当包**没有**可用的 `logoDark`、因而回退到亮色 `logo` / `composerIcon` 时，才给图标槽加**半透明浅罩**（不是实心白底）；已有 `logoDark` 或中性默认标不加垫。品牌图仍以包内字段为准。

## 5. 检查清单

- [ ] `assets/` 下有可读的主图标文件。
- [ ] `interface.logo` 指向该文件（建议同时设 `composerIcon`）。
- [ ] 暗色下对比度不足时已增加 `logoDark` 与资源文件。
- [ ] 路径为包内相对路径，且文件已纳入 Git / 发布 ZIP。
- [ ] 已 bump `version` 并完成发布或 dry-run。
- [ ] 在 Wework 亮色 + 暗色下核对：市场、已安装列表、Slash 菜单、输入栏预览。

## 6. OpenAI 上游镜像（含 GitHub）

Wegent 对 OpenAI 官方仓的同步是**纯透传**，不再改写 `logo` / `logoDark` / connectors / 文案。
因此 GitHub 等插件的暗色图标只能等官方包自带 `logoDark`；卸载重装也只会得到官方包当前内容。

## 7. 不需要做的事

- 不要在 Wegent / Wework 仓库里为某个品牌加内置暗色 SVG。
- 不要依赖「客户端给黑标垫浅底」代替 `logoDark`。
- 不必新增 `composerIconDark`；暗色品牌图统一用 `logoDark`。
