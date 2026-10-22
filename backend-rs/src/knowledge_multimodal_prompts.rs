// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/multimodal-default-prompts` — the system
//! default multimodal analysis prompts.
//!
//! Mirrors `app.api.endpoints.knowledge.get_multimodal_default_prompts`
//! (mounted at the `/knowledge-bases` prefix). The source resolves the session
//! user through `security.get_current_user` and then renders the constants
//! from `shared.models.multimodal_prompts` (the single source of truth shared
//! with the knowledge document converter), plus the global
//! `KNOWLEDGE_MULTIMODAL_ENABLED` switch (pydantic default `false`).
//!
//! The route is a literal sibling of the
//! `GET /api/knowledge-bases/{knowledge_base_id}` template; the more specific
//! literal route wins dispatch inside the Rust router, so the template never
//! sees the non-integer segment.
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `shared.models.multimodal_prompts.DEFAULT_VIDEO_PROMPT` verbatim.
pub(crate) const DEFAULT_VIDEO_PROMPT: &str = r#"你是一个全能的多模态视频内容分析与档案挖掘专家。
我已将完整的长视频文件提供给你。请你从全局视角出发，完整分析并深度提取视频中的视觉、听觉、文本和情感元素，将其转化为一份高密度、结构化、带有精确时间戳的 Markdown 档案，用于后续向量数据库检索（RAG）。

【🚨 核心要求：全时段覆盖与硬性时间约束（违反则视为任务失败）】
1. **精准首尾锚定**：
   - 章节 1 的开始时间必须严格为 `00:00:00`。
   - **最终章节的结束时间必须严格对应视频的最后一秒（总时长）**。
2. **时间轴绝对连续与无间隙**：
   - 章节之间必须做到 **[前一章结束时间 = 后一章开始时间]**，全程无间隙、无重叠、无遗漏。
3. **禁止任何形式的偷懒/截断**：
   - 严禁出现“由于篇幅限制...”、“中间部分略...”、“以此类推...”、“...（直到视频结束）...”等省略语句。
   - 必须完整按模板生成每一个章节，直到视频完全播放完毕。
4. **输出规范**：
   - 请直接输出 Markdown 内容，**严禁输出任何前置客套话、说明语或后置总结**。

---

请严格按照以下 Markdown 模板生成：

# {{VIDEO_FILENAME}}

## 🌐 一、 全局总览
- **视频总时长**：[准确填写视频总时长，格式为 HH:MM:SS]
- **视频内容类型**：[判断视频的核心体裁，例如：跨年晚会 / 旅行Vlog / 剧情MV / 动物纪录片 / 访谈脱口秀等]
- **核心主旨/情绪**：[用一句话高度概括整个长视频的核心内容或主要传递的情感氛围]
- **全局脉络总结**：[用 2-3 段话总结视频的整体走向及演进逻辑]

## ⏱️ 二、 全时段连续章节解析
（从 00:00:00 开始循环生成，直到视频最后一秒）

### 章节 1：[核心标题] ([00:00:00] - [HH:MM:SS])
> **本段摘要**：[用 1-2 句话概括核心事件/表演/情节，包含核心人物或重要实体]

- 👁️ **视觉与画面（Visuals）**：
  - **场景与氛围**：[物理环境/虚拟布景、灯光色调及整体氛围]
  - **人物与动作**：[人物外貌、服装造型、核心动作、表情及互动细节]
  - **镜头语言与特效**：[景别、运镜手法、剪辑节奏、特效或转场]
- 🗣️ **听觉与声音（Audio）**：
  - **对话/歌词/旁白**：[提炼核心关键语句/歌词/主持报幕]
  - **音乐与音效**：[BGM风格节奏、环境音、现场观众反应等]
- 📝 **画面关键文本 (OCR/Text)**：
  - **屏幕提词与花字**：[提取字幕、标题、花字、台标、标语等，无则填“无”]
- 🏷️ **检索标签（Tags）**：[3-5个高频检索标签，如：#标签1 #标签2 #标签3]

### 章节 2：[核心标题] ([上一章结束时间] - [HH:MM:SS])
> **本段摘要**：...
...

（依此类推，持续生成完整章节）

### 章节 N（最终章）：[尾声/致谢/结尾标题] ([上一章结束时间] - [视频总时长/最后一秒])
> **本段摘要**：[概括视频收尾部分的情节/表演/致谢等内容]
- 👁️ **视觉与画面（Visuals）**：...
- 🗣️ **听觉与声音（Audio）**：...
- 📝 **画面关键文本 (OCR/Text)**：...
- 🏷️ **检索标签（Tags）**：..."#;

/// `shared.models.multimodal_prompts.DEFAULT_IMAGE_PROMPT` verbatim.
pub(crate) const DEFAULT_IMAGE_PROMPT: &str = r#"你是一个全能的视觉认知专家与数字档案分析师。
请仔细观察我提供给你的图片，从视觉构图、核心文案、深层意图以及细节元素等多个维度进行深度解析，并将其转化为一份高密度、结构化的 Markdown 档案，以便用于后续的向量数据库检索（RAG）。

你的核心任务是：准确识别图片的体裁（如海报、报告、照片、画册等），并根据体裁提取最关键的信息。不仅要描述“看到了什么”，还要解读“想表达什么”。

【严格输出规范】
1. 绝对不要输出任何问候语、前导词或后缀总结。
2. 严格按照以下提供的 Markdown 结构输出，保留所有的各级标题。
3. 如果图片中完全不包含某个维度的信息（例如纯风景照没有文字），请在该项直接填写“无”，不要自行编造。

请按照以下 Markdown 模板生成你的报告：

# 🖼️ 图像多模态综合档案

## 👁️ 一、 核心摘要与体裁
- **一句话总结**：[用 1-2 句话高度概括图片的核心事件、主旨或推广目标。]
- **图像体裁**：[精确识别图片类型。例如：活动宣传海报 / 产品画册 / 行业报告截图 / 儿童绘本插画 / 生活纪实照片 / 社交网络梗图 / 艺术设计图等。]
- **视觉风格与色调**：[描述画面的整体风格与主色调。例如：极简扁平风、高端黑金质感、温馨马卡龙色、高饱和度赛博朋克等。]

## 📐 二、 视觉主体与构图排版
- **核心主体（人物/产品/物件）**：[详细描述画面的视觉中心。如：海报中心的护肤品瓶身、画册上的主打车型、绘本里的卡通人物、照片中的主要人物动作与神态。]
- **排版与构图**：[描述画面的空间布局。例如：居中对称构图、文字左对齐而产品在右、大字报式满版排版、留白较多等。]
- **背景与装饰元素**：[描述衬托主体的环境或设计元素。如：背后的光晕效果、点缀的几何图形、拍摄时的自然风景等。]

## 📝 三、 核心文案与信息提取 (OCR+)
- **主标题/核心Slogan**：[精确提取图片中字号最大、最醒目的核心文案。这是检索权重的核心。无则填“无”]
- **关键细节文本**：[提取支撑性信息。如：海报上的活动时间/地点、画册上的产品核心参数、报告图片中的关键结论句。不需要全盘照抄，提取核心骨干。无则填“无”]
- **品牌与标识 (Logo/IP)**：[识别图片中出现的品牌 Logo、赞助商图标或特定的 IP 形象。无则填“无”]

## 💡 四、 深层意图与逻辑解读
- **传达意图/情绪**：[解读这张图片的设计目的或情绪感染力。例如：“旨在制造大促抢购的紧迫感”、“传达品牌环保有机的理念”、“表现节日的喜庆氛围”、“呈现报告数据的断崖式下跌趋势”。]
- **图表结论 (针对报告/数据图)**：[如果图片是包含折线图、饼图、漏斗图等的数据报告截图，请直接给出该图表反映的核心结论（例如：“Q4 利润环比增长 20%”）。非此类图填“无”]

## 🏷️ 五、 检索关键词 (Tags)
- **全局标签**：[生成 5-8 个高频检索关键词，格式如：#标签1 #标签2。必须涵盖：1. 图像体裁；2. 核心实体；3. 设计风格；4. 抽象概念（如 #双十一、#科技感、#早教、#促销）。]"#;

/// `{"enabled": bool, "video_prompt": str, "image_prompt": str}` — the
/// endpoint's response body, in the source's key order.
#[derive(Debug, serde::Serialize)]
struct MultimodalDefaultPromptsResponse {
    enabled: bool,
    video_prompt: &'static str,
    image_prompt: &'static str,
}

/// The pydantic `bool` literals a settings field accepts, case-insensitive.
fn parse_setting_bool(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on" | "y" | "t"
    )
}

/// `settings.KNOWLEDGE_MULTIMODAL_ENABLED` with the pydantic default `false`.
fn multimodal_enabled() -> bool {
    crate::config::env_or_dotenv("KNOWLEDGE_MULTIMODAL_ENABLED")
        .as_deref()
        .map(parse_setting_bool)
        .unwrap_or(false)
}

/// GET /api/knowledge-bases/multimodal-default-prompts: the knowledge-bases
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge-bases/multimodal-default-prompts")]
async fn get_multimodal_default_prompts(
    #[inject(state)] _state: &AppState,
    #[auth] _current_user: crate::auth::SessionUser,
) -> Result<MultimodalDefaultPromptsResponse, FastApiError> {
    Ok(MultimodalDefaultPromptsResponse {
        enabled: multimodal_enabled(),
        video_prompt: DEFAULT_VIDEO_PROMPT,
        image_prompt: DEFAULT_IMAGE_PROMPT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pydantic settings field accepts the same literal set as the query
    /// booleans, case-insensitively.
    #[test]
    fn setting_bool_accepts_pydantic_literals() {
        assert!(parse_setting_bool("true"));
        assert!(parse_setting_bool("True"));
        assert!(parse_setting_bool("1"));
        assert!(parse_setting_bool("on"));
        assert!(parse_setting_bool("YES"));
        assert!(!parse_setting_bool("false"));
        assert!(!parse_setting_bool("0"));
        assert!(!parse_setting_bool("off"));
        assert!(!parse_setting_bool("n"));
        // An invalid literal would fail pydantic startup validation; the
        // endpoint never observes one in a booted process.
    }

    /// The response keeps the source key order and renders both constants.
    #[test]
    fn response_serializes_in_the_source_key_order() {
        let rendered = crate::json_contract_tests::serialized(MultimodalDefaultPromptsResponse {
            enabled: true,
            video_prompt: DEFAULT_VIDEO_PROMPT,
            image_prompt: DEFAULT_IMAGE_PROMPT,
        })
        .unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["enabled", "video_prompt", "image_prompt"]);
        assert_eq!(rendered["enabled"], true);
        assert_eq!(rendered["video_prompt"], DEFAULT_VIDEO_PROMPT);
        assert_eq!(rendered["image_prompt"], DEFAULT_IMAGE_PROMPT);
    }

    /// Both constants match the recorded exchange byte-for-byte: the video
    /// prompt is 3325 UTF-8 bytes and the image prompt 3467, both ending with
    /// the closing template marker rather than a newline.
    #[test]
    fn prompt_constants_match_the_recorded_sizes() {
        assert_eq!(DEFAULT_VIDEO_PROMPT.len(), 3325);
        assert_eq!(DEFAULT_IMAGE_PROMPT.len(), 3467);
        assert!(DEFAULT_VIDEO_PROMPT.ends_with("（Tags）**：..."));
        assert!(DEFAULT_IMAGE_PROMPT.ends_with("#早教、#促销）。]"));
    }

    /// The cutover and the handler registration must agree. The route table
    /// selects the literal path for Rust, and the router registers it, so the
    /// `{knowledge_base_id}` template never captures the literal segment.
    #[test]
    fn registered_route_keeps_python_ownership() {
        const PATH: &str = "/api/knowledge-bases/multimodal-default-prompts";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(
            &http::Method::GET,
            "/api/knowledge-bases/multimodal-default-prompts"
        ));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
