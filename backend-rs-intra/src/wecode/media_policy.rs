//! Weibo externally stored videos require the playback API.
pub struct WecodeMediaPolicy;
impl wegent_backend_rs::media_policy::MediaPolicy for WecodeMediaPolicy {
    fn download_unsupported(
        &self,
        context_type: &str,
        extension: &str,
        storage_backend: &str,
    ) -> bool {
        context_type == "attachment"
            && storage_backend == "weibo"
            && [".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv"]
                .contains(&extension.to_lowercase().as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wegent_backend_rs::media_policy::MediaPolicy;
    #[test]
    fn only_external_video_attachments_require_playback() {
        assert!(WecodeMediaPolicy.download_unsupported("attachment", ".MP4", "weibo"));
        assert!(!WecodeMediaPolicy.download_unsupported("attachment", ".mp4", "s3"));
        assert!(!WecodeMediaPolicy.download_unsupported("attachment", ".png", "weibo"));
        assert!(!WecodeMediaPolicy.download_unsupported("text", ".mp4", "weibo"));
    }
}
