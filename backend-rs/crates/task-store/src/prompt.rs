use brz_json::JsonProjection;

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PromptBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

/// `parse_prompt_blocks` (shared/prompts/constants.py): plain text passes
/// through; JSON block lists keep only the user-visible text.
pub fn extract_display_prompt(prompt: Option<&str>) -> Option<String> {
    let prompt = prompt?;
    if let Ok(JsonProjection {
        value: Some(blocks),
    }) = serde_json::from_str::<JsonProjection<Vec<Option<PromptBlock>>>>(prompt)
    {
        return Some(parse_block_list(&blocks, prompt));
    }
    if prompt.contains("[User Question]:") {
        return Some(extract_user_question(prompt).to_owned());
    }
    Some(prompt.to_owned())
}

fn parse_block_list(blocks: &[Option<PromptBlock>], raw_prompt: &str) -> String {
    let mut user_text: Option<String> = None;
    for block in blocks.iter().filter_map(|block| block.as_ref()) {
        let block_type = block.kind.as_deref().unwrap_or("");
        if block_type != "text" && block_type != "input_text" {
            continue;
        }
        let text = block.text.as_deref().unwrap_or("");
        let stripped = text.trim_start();
        if stripped.starts_with("<system-reminder>") {
            continue;
        }
        if stripped.starts_with("[User Question]:") && user_text.is_none() {
            user_text = Some(extract_user_question(stripped).to_owned());
            continue;
        }
        if stripped.starts_with("<attachment>") || stripped.starts_with("<selected_documents>") {
            continue;
        }
        if user_text.is_none() {
            user_text = Some(text.to_owned());
        }
    }
    user_text.unwrap_or_else(|| raw_prompt.to_owned())
}

fn extract_user_question(text: &str) -> &str {
    if let Some((_, after)) = text.split_once("[User Question]:") {
        after.trim_start_matches('\n').trim()
    } else {
        text.trim()
    }
}
