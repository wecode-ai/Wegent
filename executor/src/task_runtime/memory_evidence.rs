//! Lossless, version-bound JSON evidence chunks shared by memory sources.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) fn review_completed(progress: &Value, chunk: &Value) -> bool {
    chunk["contentHash"].is_string()
        && progress["completedContentHash"] == chunk["contentHash"]
        && !progress["pendingWrites"]
            .as_array()
            .is_some_and(|writes| !writes.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_completed_evidence_never_hides_unsettled_writes() {
        let chunk = json!({"contentHash":"a".repeat(64)});
        let mut progress = json!({"completedContentHash":chunk["contentHash"],"pendingWrites":[]});
        assert!(review_completed(&progress, &chunk));
        progress["pendingWrites"] = json!(["failed-save"]);
        assert!(!review_completed(&progress, &chunk));
        progress["pendingWrites"] = json!([]);
        assert!(!review_completed(
            &progress,
            &json!({"contentHash":"b".repeat(64)})
        ));
        assert!(!review_completed(&json!({}), &json!({})));
    }
}

pub(crate) fn chunk(value: &Value, args: &Value) -> Result<Value, String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let offset = match args.get("offset") {
        None => 0,
        Some(value) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or("Invalid memory evidence offset")?,
    };
    if offset > 0 && !args["contentHash"].is_string() {
        return Err("Memory evidence continuation requires contentHash".into());
    }
    if args["contentHash"]
        .as_str()
        .is_some_and(|expected| expected != hash)
    {
        return Err("Memory evidence changed; restart at offset zero".into());
    }
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("Invalid memory evidence offset".into());
    }
    let mut end = offset.saturating_add(8192).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(json!({"content":&text[offset..end],"offset":offset,
        "nextOffset":(end < text.len()).then_some(end),"contentHash":hash,"totalContentBytes":text.len()}))
}
