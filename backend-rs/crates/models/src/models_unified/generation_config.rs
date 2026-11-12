// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Pydantic-compatible projection of `spec.videoConfig`, `spec.imageConfig`
//! and `spec.embeddingConfig` for `GET /api/models/unified`.
//!
//! `_extract_model_info_from_crd` validates every model CRD through
//! `app.schemas.kind.Model` and serializes the nested video and image
//! configuration with `model_dump(exclude_none=True)`. The public adapter
//! `to_model_dict` additionally serializes `spec.embeddingConfig`. That dump is
//! not a raw passthrough: pydantic keeps the declared field order and per-field
//! defaults, coerces lax input (`2` into an `Optional[float]`, `"true"` into an
//! `Optional[bool]`), drops unknown keys and drops every `None`. The types
//! below mirror `app/schemas/generation.py` and `app/schemas/kind.py` field for
//! field and reproduce that dump. A conversion failure stands in for the
//! `pydantic.ValidationError` that makes the caller fall back to its error
//! projection.
//!
//! Integer fields are represented as `i64`, so an integer literal outside the
//! signed 64-bit range is rejected where pydantic would keep it as an
//! arbitrary-precision value. Model configuration never carries such a value.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Map as JsonMap;
use serde_json::Value as Json;

/// Stands in for `pydantic.ValidationError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid;

type Valid<T> = Result<T, Invalid>;

/// `spec.videoConfig` -> `VideoGenerationConfig.model_dump(exclude_none=True)`.
pub fn video_config_dump(raw: &Json) -> Valid<Json> {
    dump::<VideoGenerationConfig>(raw)
}

/// `spec.imageConfig` -> `ImageGenerationConfig.model_dump(exclude_none=True)`.
pub fn image_config_dump(raw: &Json) -> Valid<Json> {
    dump::<ImageGenerationConfig>(raw)
}

/// `spec.embeddingConfig` -> `EmbeddingConfig.model_dump(exclude_none=True)`.
///
/// `EmbeddingConfig` sets `extra="allow"`, so unlike the video and image
/// configs it keeps unknown keys. The declared fields render first in
/// declaration order, then the remaining keys in their input order; every
/// `None` value — declared or extra — is dropped.
pub fn embedding_config_dump(raw: &Json) -> Valid<Json> {
    let Json::Object(source) = raw else {
        return Err(Invalid);
    };
    #[derive(Deserialize)]
    struct Declared {
        #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
        dimensions: Option<i64>,
        #[serde(
            default = "default_encoding_format",
            deserialize_with = "brz_json::adapters::optional_str"
        )]
        encoding_format: Option<String>,
        #[serde(default, deserialize_with = "brz_json::adapters::optional_strings")]
        additional_input_modalities: Option<Vec<String>>,
    }
    let declared: Declared =
        serde_json::from_value(Json::Object(source.clone())).map_err(|_| Invalid)?;
    let mut output = JsonMap::new();
    if let Some(value) = declared.dimensions {
        output.insert("dimensions".into(), Json::Number(value.into()));
    }
    if let Some(value) = declared.encoding_format {
        output.insert("encoding_format".into(), Json::String(value));
    }
    if let Some(value) = declared.additional_input_modalities {
        output.insert(
            "additional_input_modalities".into(),
            serde_json::to_value(value).map_err(|_| Invalid)?,
        );
    }
    for (key, value) in source {
        if matches!(
            key.as_str(),
            "dimensions" | "encoding_format" | "additional_input_modalities"
        ) || value.is_null()
        {
            continue;
        }
        output.insert(key.clone(), value.clone());
    }
    Ok(Json::Object(output))
}

fn default_encoding_format() -> Option<String> {
    Some("float".to_string())
}

fn dump<T>(raw: &Json) -> Valid<Json>
where
    T: DeserializeOwned + Serialize + Validate,
{
    // pydantic validates a model only from a mapping; serde would also accept a
    // positional JSON array, so the mapping shape is checked first.
    if !raw.is_object() {
        return Err(Invalid);
    }
    let value = T::deserialize(raw).map_err(|_| Invalid)?;
    value.validate()?;
    serde_json::to_value(&value).map_err(|_| Invalid)
}

/// Field bounds applied after deserialization, mirroring the `Field(...)`
/// constraints declared in `app/schemas/generation.py`.
trait Validate {
    fn validate(&self) -> Valid<()>;

    fn positive(value: Option<i64>) -> bool {
        value.is_none_or(|value| value > 0)
    }

    fn non_negative(value: Option<i64>) -> bool {
        value.is_none_or(|value| value >= 0)
    }

    fn positive_number(value: Option<f64>) -> bool {
        value.is_none_or(|value| value > 0.0)
    }

    fn non_negative_number(value: Option<f64>) -> bool {
        value.is_none_or(|value| value >= 0.0)
    }
}

/// One option of `VideoCapabilities.aspect_ratios`.
#[derive(Deserialize, Serialize)]
struct AspectRatioOption {
    #[serde(deserialize_with = "brz_json::adapters::required_str")]
    label: String,
    #[serde(deserialize_with = "brz_json::adapters::required_str")]
    value: String,
}

/// One option of `VideoCapabilities.resolutions`.
#[derive(Deserialize, Serialize)]
struct ResolutionOption {
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
    #[serde(deserialize_with = "brz_json::adapters::required_str")]
    label: String,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    tooltip: Option<String>,
}

/// One entry of `VideoCapabilities.generation_modes`.
#[derive(Deserialize, Serialize)]
struct VideoGenerationMode {
    #[serde(deserialize_with = "brz_json::adapters::required_str")]
    id: String,
    #[serde(deserialize_with = "brz_json::adapters::required_str")]
    label: String,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_images: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_videos: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_audios: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_total: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_images_first_last: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_required: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    first_frame_required: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_allowed: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_allowed: Option<bool>,
}

impl Validate for VideoGenerationMode {
    fn validate(&self) -> Valid<()> {
        if self.id.is_empty() || self.label.is_empty() {
            return Err(Invalid);
        }
        let counts = [
            self.max_images,
            self.max_videos,
            self.max_audios,
            self.max_total,
            self.max_images_first_last,
        ];
        if counts.iter().any(|value| !Self::non_negative(*value)) {
            return Err(Invalid);
        }
        Ok(())
    }
}

/// `VideoCapabilities`.
#[derive(Deserialize, Serialize)]
struct VideoCapabilities {
    #[serde(default, deserialize_with = "brz_json::adapters::optional_objects")]
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratios: Option<Vec<AspectRatioOption>>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_objects")]
    #[serde(skip_serializing_if = "Option::is_none")]
    resolutions: Option<Vec<ResolutionOption>>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integers")]
    #[serde(skip_serializing_if = "Option::is_none")]
    durations_sec: Option<Vec<i64>>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_image_input: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_video_input: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_audio_input: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    generate_audio: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_materials: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images_with_video: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_videos: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_audios: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_input_required: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_material_required: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_dimension: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_dimension: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_dimension: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_dimension: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_pixels: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_pixels: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_fps: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_fps: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_min_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_max_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_objects")]
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_modes: Option<Vec<VideoGenerationMode>>,
}

impl Validate for VideoCapabilities {
    fn validate(&self) -> Valid<()> {
        let references = [
            self.max_reference_materials,
            self.max_reference_images,
            self.max_reference_images_with_video,
            self.max_reference_videos,
            self.max_reference_audios,
        ];
        if references.iter().any(|value| !Self::non_negative(*value)) {
            return Err(Invalid);
        }
        let durations = [self.video_min_duration_sec, self.audio_min_duration_sec];
        if durations
            .iter()
            .any(|value| !Self::non_negative_number(*value))
        {
            return Err(Invalid);
        }
        let sizes = [
            self.image_max_size_mb,
            self.image_min_dimension,
            self.image_max_dimension,
            self.video_max_size_mb,
            self.video_min_dimension,
            self.video_max_dimension,
            self.video_min_pixels,
            self.video_max_pixels,
            self.audio_max_size_mb,
        ];
        if sizes.iter().any(|value| !Self::positive(*value)) {
            return Err(Invalid);
        }
        let numbers = [
            self.image_min_aspect_ratio,
            self.image_max_aspect_ratio,
            self.video_max_duration_sec,
            self.video_min_aspect_ratio,
            self.video_max_aspect_ratio,
            self.video_min_fps,
            self.video_max_fps,
            self.audio_max_duration_sec,
        ];
        if numbers.iter().any(|value| !Self::positive_number(*value)) {
            return Err(Invalid);
        }
        for mode in self.generation_modes.iter().flatten() {
            mode.validate()?;
        }
        Ok(())
    }
}

/// `VideoGenerationConfig`.
#[derive(Deserialize, Serialize)]
struct VideoGenerationConfig {
    #[serde(default = "default_video_resolution")]
    #[serde(deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<String>,
    #[serde(
        default = "default_fps",
        deserialize_with = "brz_json::adapters::optional_integer"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    fps: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_duration: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    ratio: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    generate_audio: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    camera_fixed: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    watermark: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    omni_reference_task_type: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_object")]
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<VideoCapabilities>,
}

impl Validate for VideoGenerationConfig {
    fn validate(&self) -> Valid<()> {
        if let Some(priority) = self.priority
            && !(0..=9).contains(&priority)
        {
            return Err(Invalid);
        }
        if !Self::non_negative(self.max_reference_images) {
            return Err(Invalid);
        }
        if !matches!(self.output_format.as_deref(), None | Some("mp4" | "mov")) {
            return Err(Invalid);
        }
        let task_types = ["auto", "reference", "edit", "extend"];
        if let Some(value) = self.omni_reference_task_type.as_deref()
            && !task_types.contains(&value)
        {
            return Err(Invalid);
        }
        if let Some(capabilities) = &self.capabilities {
            capabilities.validate()?;
        }
        Ok(())
    }
}

/// `ImageCapabilities`.
#[derive(Deserialize, Serialize)]
struct ImageCapabilities {
    #[serde(default, deserialize_with = "brz_json::adapters::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_image_input: Option<bool>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_dimension: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_dimension: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_aspect_ratio: Option<f64>,
}

impl Validate for ImageCapabilities {
    fn validate(&self) -> Valid<()> {
        let sizes = [
            self.image_max_size_mb,
            self.image_min_dimension,
            self.image_max_dimension,
        ];
        if sizes.iter().any(|value| !Self::positive(*value)) {
            return Err(Invalid);
        }
        if !Self::non_negative(self.max_reference_images) {
            return Err(Invalid);
        }
        let numbers = [self.image_min_aspect_ratio, self.image_max_aspect_ratio];
        if numbers.iter().any(|value| !Self::positive_number(*value)) {
            return Err(Invalid);
        }
        Ok(())
    }
}

/// `ImageGenerationConfig`.
#[derive(Deserialize, Serialize)]
struct ImageGenerationConfig {
    #[serde(
        default = "default_image_size",
        deserialize_with = "brz_json::adapters::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_object")]
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<ImageCapabilities>,
    #[serde(
        default = "default_sequential_image_generation",
        deserialize_with = "brz_json::adapters::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    sequential_image_generation: Option<String>,
    #[serde(
        default = "default_max_images",
        deserialize_with = "brz_json::adapters::optional_integer"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_images: Option<i64>,
    #[serde(
        default = "default_response_format",
        deserialize_with = "brz_json::adapters::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<String>,
    #[serde(
        default = "default_image_output_format",
        deserialize_with = "brz_json::adapters::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    output_compression: Option<i64>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    background: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    moderation: Option<String>,
    #[serde(
        default = "default_watermark",
        deserialize_with = "brz_json::adapters::optional_boolean"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    watermark: Option<bool>,
    #[serde(
        default = "default_optimize_prompt_mode",
        deserialize_with = "brz_json::adapters::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    optimize_prompt_mode: Option<String>,
    #[serde(
        default = "default_image_max_reference_images",
        deserialize_with = "brz_json::adapters::optional_integer"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images: Option<i64>,
}

impl Validate for ImageGenerationConfig {
    fn validate(&self) -> Valid<()> {
        if let Some(max_images) = self.max_images
            && !(1..=15).contains(&max_images)
        {
            return Err(Invalid);
        }
        if let Some(compression) = self.output_compression
            && !(0..=100).contains(&compression)
        {
            return Err(Invalid);
        }
        if let Some(references) = self.max_reference_images
            && !(0..=20).contains(&references)
        {
            return Err(Invalid);
        }
        if let Some(capabilities) = &self.capabilities {
            capabilities.validate()?;
        }
        Ok(())
    }
}

fn default_video_resolution() -> Option<String> {
    Some("1080p".to_string())
}

fn default_fps() -> Option<i64> {
    Some(24)
}

fn default_image_size() -> Option<String> {
    Some("2048x2048".to_string())
}

fn default_sequential_image_generation() -> Option<String> {
    Some("disabled".to_string())
}

fn default_max_images() -> Option<i64> {
    Some(1)
}

fn default_response_format() -> Option<String> {
    Some("url".to_string())
}

fn default_image_output_format() -> Option<String> {
    Some("jpeg".to_string())
}

fn default_watermark() -> Option<bool> {
    Some(false)
}

fn default_optimize_prompt_mode() -> Option<String> {
    Some("standard".to_string())
}

fn default_image_max_reference_images() -> Option<i64> {
    Some(1)
}

#[cfg(test)]
#[path = "generation_config_tests.rs"]
mod tests;
