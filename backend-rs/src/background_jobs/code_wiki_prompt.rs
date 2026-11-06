//! The source prompts are embedded verbatim; only run facts vary.
pub(super) struct Context<'a> {
    pub project: &'a str,
    pub generation: i64,
    pub head: &'a str,
    pub previous: &'a str,
    pub language: &'a str,
    pub strategy: &'a str,
    pub reviewer: &'a str,
    pub writer: &'a str,
    pub changed: &'a [String],
    pub existing: &'a [String],
}
pub(super) fn build(c: &Context<'_>, full: bool) -> String {
    let intro_strategy =
        if full && matches!(c.strategy, "coordinator_adaptive" | "coordinator_solo") {
            format!("\n- Strategy: `{}`", c.strategy)
        } else {
            String::new()
        };
    let mut intro = include_str!("code_wiki_prompts/full_rebuild_intro.md").to_owned();
    intro = intro.replace("{{strategy}}", &intro_strategy);
    let template = if !full {
        include_str!("code_wiki_prompts/build_incremental_prompt.md")
    } else {
        match c.strategy {
            "coordinator_adaptive" => {
                include_str!("code_wiki_prompts/build_adaptive_full_prompt.md")
            }
            "coordinator_solo" => include_str!("code_wiki_prompts/build_solo_full_prompt.md"),
            _ => include_str!("code_wiki_prompts/build_full_prompt.md"),
        }
    };
    let mut result = template.replace("{{intro}}", &intro);
    let changed = if c.changed.is_empty() {
        "- (no file list was available)".into()
    } else {
        c.changed
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let existing = if c.existing.is_empty() {
        "- (the wiki is currently empty)".into()
    } else {
        c.existing
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    for (key, value) in [
        ("project_name", c.project.to_owned()),
        ("generation_id", c.generation.to_string()),
        (
            "head_commit",
            if c.head.is_empty() {
                "current HEAD"
            } else {
                c.head
            }
            .to_owned(),
        ),
        (
            "previous_commit",
            if c.previous.is_empty() {
                "the last documented commit"
            } else {
                c.previous
            }
            .to_owned(),
        ),
        ("language", c.language.into()),
        (
            "reviewer",
            if c.reviewer.is_empty() {
                "the configured reviewer agent"
            } else {
                c.reviewer
            }
            .into(),
        ),
        (
            "writer",
            if c.writer.is_empty() {
                "the configured Section Writer agent"
            } else {
                c.writer
            }
            .into(),
        ),
        ("changed", changed),
        ("existing", existing),
    ] {
        result = result.replace(&format!("{{{{{key}}}}}"), &value)
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adaptive_and_incremental_preserve_distinct_page_contracts() {
        let c = Context {
            project: "org/repo",
            generation: 7,
            head: "sha",
            previous: "old",
            language: "English",
            strategy: "coordinator_adaptive",
            reviewer: "",
            writer: "writer-9",
            changed: &[],
            existing: &[],
        };
        let full = build(&c, true);
        assert!(full.contains("writer-9"));
        assert!(full.contains("Strategy: `coordinator_adaptive`"));
        assert!(!full.contains("{{"));
        assert!(full.contains("Your version begins empty"));
        let incremental = build(&c, false);
        assert!(incremental.contains("pages you do not touch are carried over unchanged"));
        assert!(!incremental.contains("{{"));
    }
}
