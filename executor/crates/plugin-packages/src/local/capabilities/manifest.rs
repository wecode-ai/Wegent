//! Capability manifest persistence.
use super::*;

impl ManagedCapabilityManifest {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<Value, CapabilitySyncError> {
        manifest_migration::initialize(&self.path)?;
        if !self.path.exists() {
            return Ok(default_manifest());
        }
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&self.path)?)?;
        manifest_migration::validate_current(&self.path, &value)?;
        normalize_manifest(&mut value);
        Ok(value)
    }

    pub fn save(&self, mut value: Value) -> Result<(), CapabilitySyncError> {
        manifest_migration::prepare_save(&self.path, &mut value)?;
        normalize_manifest(&mut value);
        write_plugin_manifest_atomic(&self.path, &value)
    }

    pub(super) fn save_with_revision_bump(
        &self,
        mut value: Value,
    ) -> Result<(), CapabilitySyncError> {
        manifest_migration::prepare_save(&self.path, &mut value)?;
        normalize_manifest(&mut value);
        let revision = value
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            + 1;
        value["revision"] = json!(revision);
        write_plugin_manifest_atomic(&self.path, &value)
    }
}

pub(super) fn write_plugin_manifest_atomic(
    path: &Path,
    manifest: &Value,
) -> Result<(), CapabilitySyncError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temporary, manifest)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(temporary.path(), metadata.permissions())?;
    }
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}
