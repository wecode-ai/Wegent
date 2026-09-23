// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Pydantic-compatible projection of `spec.videoConfig` and
//! `spec.imageConfig` for `GET /api/models/unified`.
//!
//! `_extract_model_info_from_crd` validates every model CRD through
//! `app.schemas.kind.Model` and serializes the nested video and image
//! configuration with `model_dump(exclude_none=True)`. That dump is not a raw
//! passthrough: pydantic keeps the declared field order and per-field defaults,
//! coerces lax input (`2` into an `Optional[float]`, `"true"` into an
//! `Optional[bool]`), drops unknown keys and drops every `None`. The types
//! below mirror `app/schemas/generation.py` field for field and reproduce that
//! dump. A conversion failure stands in for the `pydantic.ValidationError`
//! that makes the caller fall back to its error projection.
//!
//! Integer fields are represented as `i64`, so an integer literal outside the
//! signed 64-bit range is rejected where pydantic would keep it as an
//! arbitrary-precision value. Model configuration never carries such a value.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
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
    #[serde(deserialize_with = "lax::required_str")]
    label: String,
    #[serde(deserialize_with = "lax::required_str")]
    value: String,
}

/// One option of `VideoCapabilities.resolutions`.
#[derive(Deserialize, Serialize)]
struct ResolutionOption {
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
    #[serde(deserialize_with = "lax::required_str")]
    label: String,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    tooltip: Option<String>,
}

/// One entry of `VideoCapabilities.generation_modes`.
#[derive(Deserialize, Serialize)]
struct VideoGenerationMode {
    #[serde(deserialize_with = "lax::required_str")]
    id: String,
    #[serde(deserialize_with = "lax::required_str")]
    label: String,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_images: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_videos: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_audios: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_total: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_images_first_last: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_required: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    first_frame_required: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_allowed: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
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
    #[serde(default, deserialize_with = "lax::optional_aspect_ratios")]
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratios: Option<Vec<AspectRatioOption>>,
    #[serde(default, deserialize_with = "lax::optional_resolutions")]
    #[serde(skip_serializing_if = "Option::is_none")]
    resolutions: Option<Vec<ResolutionOption>>,
    #[serde(default, deserialize_with = "lax::optional_integers")]
    #[serde(skip_serializing_if = "Option::is_none")]
    durations_sec: Option<Vec<i64>>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_image_input: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_video_input: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_audio_input: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    generate_audio: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_materials: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images_with_video: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_videos: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_audios: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_input_required: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_material_required: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_dimension: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_dimension: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_dimension: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_dimension: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_pixels: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_pixels: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_min_fps: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    video_max_fps: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_min_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_max_duration_sec: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_generation_modes")]
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
    #[serde(deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<String>,
    #[serde(default = "default_fps", deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    fps: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_duration: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    ratio: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    generate_audio: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    camera_fixed: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    watermark: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    omni_reference_task_type: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_video_capabilities")]
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
    #[serde(default, deserialize_with = "lax::optional_boolean")]
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_image_input: Option<bool>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_reference_images: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_strings")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_formats: Option<Vec<String>>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_size_mb: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_dimension: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_max_dimension: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
    #[serde(skip_serializing_if = "Option::is_none")]
    image_min_aspect_ratio: Option<f64>,
    #[serde(default, deserialize_with = "lax::optional_number")]
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
    #[serde(default = "default_image_size", deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_image_capabilities")]
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<ImageCapabilities>,
    #[serde(
        default = "default_sequential_image_generation",
        deserialize_with = "lax::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    sequential_image_generation: Option<String>,
    #[serde(
        default = "default_max_images",
        deserialize_with = "lax::optional_integer"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    max_images: Option<i64>,
    #[serde(
        default = "default_response_format",
        deserialize_with = "lax::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<String>,
    #[serde(
        default = "default_image_output_format",
        deserialize_with = "lax::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_integer")]
    #[serde(skip_serializing_if = "Option::is_none")]
    output_compression: Option<i64>,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    background: Option<String>,
    #[serde(default, deserialize_with = "lax::optional_str")]
    #[serde(skip_serializing_if = "Option::is_none")]
    moderation: Option<String>,
    #[serde(
        default = "default_watermark",
        deserialize_with = "lax::optional_boolean"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    watermark: Option<bool>,
    #[serde(
        default = "default_optimize_prompt_mode",
        deserialize_with = "lax::optional_str"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    optimize_prompt_mode: Option<String>,
    #[serde(
        default = "default_image_max_reference_images",
        deserialize_with = "lax::optional_integer"
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

/// pydantic v2 "lax" input coercion for the types used by the generation
/// schemas, matching the conversions pydantic 2.x accepts for `int`, `float`,
/// `bool` and `str`.
mod lax {
    use super::{
        AspectRatioOption, ImageCapabilities, Json, ResolutionOption, VideoCapabilities,
        VideoGenerationMode,
    };
    use serde::Deserialize;
    use serde::de::{Deserializer, Error};

    /// `int` from `str`: trimmed and optionally signed, additionally accepting
    /// an integral decimal such as `"4.0"` while rejecting `"4."`, `".5"` and
    /// exponent notation such as `"1e3"`.
    fn integer_from_str(raw: &str) -> Option<i64> {
        let text = raw.trim();
        if let Ok(value) = text.parse::<i64>() {
            return Some(value);
        }
        let (whole, fraction) = text.split_once('.')?;
        if fraction.is_empty() || !fraction.bytes().all(|byte| byte == b'0') {
            return None;
        }
        whole.parse::<i64>().ok()
    }

    /// `2^63`, the exclusive magnitude bound of the `i64` representation used
    /// for `Option[int]` fields; pydantic rejects a float beyond it.
    const I64_BOUND: f64 = 9_223_372_036_854_775_808.0;

    fn from_float(float: f64) -> Option<i64> {
        (float.is_finite() && float.fract() == 0.0 && float > -I64_BOUND && float < I64_BOUND)
            .then_some(float as i64)
    }

    fn integer(value: &Json) -> Option<i64> {
        match value {
            Json::Number(number) => match number.as_i64() {
                Some(value) => Some(value),
                None => from_float(number.as_f64()?),
            },
            Json::Bool(value) => Some(if *value { 1 } else { 0 }),
            Json::String(text) => integer_from_str(text),
            _ => None,
        }
    }

    fn number(value: &Json) -> Option<f64> {
        match value {
            Json::Number(number) => number.as_f64(),
            Json::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
            Json::String(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        }
    }

    fn boolean(value: &Json) -> Option<bool> {
        match value {
            Json::Bool(value) => Some(*value),
            Json::Number(number) => match number.as_f64()? {
                0.0 => Some(false),
                1.0 => Some(true),
                _ => None,
            },
            Json::String(text) => match text.to_lowercase().as_str() {
                "0" | "off" | "false" | "f" | "n" | "no" => Some(false),
                "1" | "on" | "true" | "t" | "y" | "yes" => Some(true),
                _ => None,
            },
            _ => None,
        }
    }

    fn strings(value: &Json) -> Option<Vec<String>> {
        let Json::Array(items) = value else {
            return None;
        };
        items
            .iter()
            .map(|item| match item {
                Json::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn integers(value: &Json) -> Option<Vec<i64>> {
        let Json::Array(items) = value else {
            return None;
        };
        items.iter().map(integer).collect()
    }

    fn models<T: serde::de::DeserializeOwned>(value: &Json) -> Option<Vec<T>> {
        let Json::Array(items) = value else {
            return None;
        };
        items.iter().map(model::<T>).collect()
    }

    fn model<T: serde::de::DeserializeOwned>(value: &Json) -> Option<T> {
        // A nested model is a mapping only; serde would also accept a
        // positional JSON array for a struct.
        if !value.is_object() {
            return None;
        }
        T::deserialize(value).ok()
    }

    fn text(value: &Json) -> Option<String> {
        match value {
            Json::String(text) => Some(text.clone()),
            _ => None,
        }
    }

    /// A field declared `Optional[...]`: an explicit `null` yields `None`, an
    /// absent key uses the field default, and every other value is coerced.
    macro_rules! optional {
        ($name:ident, $target:ty, $parse:expr) => {
            pub(super) fn $name<'de, D>(deserializer: D) -> Result<Option<$target>, D::Error>
            where
                D: Deserializer<'de>,
            {
                match Json::deserialize(deserializer)? {
                    Json::Null => Ok(None),
                    value => Ok(Some(
                        $parse(&value).ok_or_else(|| D::Error::custom(stringify!($name)))?,
                    )),
                }
            }
        };
    }

    optional!(optional_str, String, text);
    optional!(optional_integer, i64, integer);
    optional!(optional_number, f64, number);
    optional!(optional_boolean, bool, boolean);
    optional!(optional_strings, Vec<String>, strings);
    optional!(optional_integers, Vec<i64>, integers);
    optional!(
        optional_aspect_ratios,
        Vec<AspectRatioOption>,
        models::<AspectRatioOption>
    );
    optional!(
        optional_resolutions,
        Vec<ResolutionOption>,
        models::<ResolutionOption>
    );
    optional!(
        optional_generation_modes,
        Vec<VideoGenerationMode>,
        models::<VideoGenerationMode>
    );
    optional!(
        optional_video_capabilities,
        VideoCapabilities,
        model::<VideoCapabilities>
    );
    optional!(
        optional_image_capabilities,
        ImageCapabilities,
        model::<ImageCapabilities>
    );

    /// A field declared `str` without a default.
    pub(super) fn required_str<'de, D>(deserializer: D) -> Result<String, D::Error>
    where
        D: Deserializer<'de>,
    {
        match Json::deserialize(deserializer)? {
            Json::String(text) => Ok(text),
            _ => Err(D::Error::custom("string_type")),
        }
    }
}

#[cfg(test)]
#[path = "generation_config_tests.rs"]
mod tests;
