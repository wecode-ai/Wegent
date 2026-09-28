// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Coercion and bounds contract of the pydantic-compatible video and image
//! config projection.

use super::*;
use serde_json::json;

fn video(raw: Json) -> Json {
    video_config_dump(&raw).expect("video config converts")
}

fn image(raw: Json) -> Json {
    image_config_dump(&raw).expect("image config converts")
}

#[test]
fn video_capabilities_coerce_integers_into_floats() {
    // An `Optional[float]` field keeps its declared type, so the recorded
    // `video_max_fps: 60` is emitted as `60.0`, while an `Optional[int]` field
    // such as `video_max_size_mb` stays integral.
    let dumped = video(json!({
        "capabilities": {
            "video_min_duration_sec": 2,
            "video_max_duration_sec": 15,
            "video_min_fps": 24,
            "video_max_fps": 60,
            "audio_min_duration_sec": 2,
            "audio_max_duration_sec": 15,
            "video_max_size_mb": 50,
            "video_min_aspect_ratio": 0.4,
        }
    }));
    assert_eq!(
        dumped,
        json!({
            "resolution": "1080p",
            "fps": 24,
            "capabilities": {
                "video_min_duration_sec": 2.0,
                "video_max_duration_sec": 15.0,
                "video_min_fps": 24.0,
                "video_max_fps": 60.0,
                "audio_min_duration_sec": 2.0,
                "audio_max_duration_sec": 15.0,
                "video_max_size_mb": 50,
                "video_min_aspect_ratio": 0.4,
            }
        })
    );
}

#[test]
fn generation_modes_coerce_string_booleans() {
    let dumped = video(json!({
        "capabilities": {
            "generation_modes": [
                {"id": "omni_reference", "label": "all", "image_required": "false"},
                {
                    "id": "first_last_frame",
                    "label": "first",
                    "image_required": true,
                    "first_frame_required": "true",
                    "audio_allowed": "off",
                },
            ]
        }
    }));
    assert_eq!(
        dumped,
        json!({
            "resolution": "1080p",
            "fps": 24,
            "capabilities": {
                "generation_modes": [
                    {"id": "omni_reference", "label": "all", "image_required": false},
                    {
                        "id": "first_last_frame",
                        "label": "first",
                        "image_required": true,
                        "first_frame_required": true,
                        "audio_allowed": false,
                    },
                ]
            }
        })
    );
}

#[test]
fn absent_fields_use_defaults_and_explicit_nulls_are_dropped() {
    assert_eq!(video(json!({})), json!({"resolution": "1080p", "fps": 24}));
    assert_eq!(video(json!({"resolution": null, "fps": null})), json!({}));
    assert_eq!(
        video(json!({"resolution": "720p", "fps": 30, "draft": false})),
        json!({"resolution": "720p", "fps": 30, "draft": false})
    );
}

#[test]
fn unknown_keys_and_nested_nulls_are_dropped() {
    let dumped = video(json!({
        "placeholder_duration_ms": 130000,
        "capabilities": {
            "size_presets": [{"size": "1024x1024"}],
            "resolutions": [{"label": "720P", "value": "720p", "width": null, "height": null}],
            "aspect_ratios": [{"label": "adaptive", "value": "adaptive", "tooltip": null}],
        }
    }));
    assert_eq!(
        dumped,
        json!({
            "resolution": "1080p",
            "fps": 24,
            "capabilities": {
                "resolutions": [{"label": "720P", "value": "720p"}],
                "aspect_ratios": [{"label": "adaptive", "value": "adaptive"}],
            }
        })
    );
}

#[test]
fn image_config_uses_image_defaults() {
    assert_eq!(
        image(json!({})),
        json!({
            "size": "2048x2048",
            "sequential_image_generation": "disabled",
            "max_images": 1,
            "response_format": "url",
            "output_format": "jpeg",
            "watermark": false,
            "optimize_prompt_mode": "standard",
            "max_reference_images": 1,
        })
    );
    assert_eq!(
        image(json!({
            "capabilities": {
                "supports_image_input": "yes",
                "size_presets": [{"size": "1024x1024"}],
                "image_max_aspect_ratio": 3,
            }
        })),
        json!({
            "size": "2048x2048",
            "capabilities": {"supports_image_input": true, "image_max_aspect_ratio": 3.0},
            "sequential_image_generation": "disabled",
            "max_images": 1,
            "response_format": "url",
            "output_format": "jpeg",
            "watermark": false,
            "optimize_prompt_mode": "standard",
            "max_reference_images": 1,
        })
    );
}

#[test]
fn required_fields_are_enforced() {
    // `AspectRatioOption` requires both `label` and `value`.
    assert!(
        video_config_dump(&json!({"capabilities": {"aspect_ratios": [{"label": "adaptive"}]}}))
            .is_err()
    );
    // `VideoGenerationMode` requires a non-empty `id` and `label`.
    assert!(
        video_config_dump(&json!({
            "capabilities": {"generation_modes": [{"id": "", "label": "x"}]}
        }))
        .is_err()
    );
    assert!(
        video_config_dump(&json!({
            "capabilities": {"generation_modes": [{"label": "x"}]}
        }))
        .is_err()
    );
}

#[test]
fn declared_bounds_are_enforced() {
    assert!(video_config_dump(&json!({"capabilities": {"video_max_fps": 0}})).is_err());
    assert!(video_config_dump(&json!({"capabilities": {"max_reference_images": -1}})).is_err());
    assert!(video_config_dump(&json!({"priority": 10})).is_err());
    assert!(video_config_dump(&json!({"priority": 0})).is_ok());
    assert!(video_config_dump(&json!({"output_format": "avi"})).is_err());
    assert!(video_config_dump(&json!({"output_format": "mov"})).is_ok());
    assert!(image_config_dump(&json!({"max_images": 0})).is_err());
    assert!(image_config_dump(&json!({"max_images": 16})).is_err());
    assert!(image_config_dump(&json!({"output_compression": 101})).is_err());
    assert!(image_config_dump(&json!({"max_reference_images": 21})).is_err());
}

#[test]
fn non_object_configs_are_rejected() {
    assert!(video_config_dump(&json!(null)).is_err());
    assert!(video_config_dump(&json!("nope")).is_err());
    assert!(video_config_dump(&json!([1])).is_err());
    assert!(image_config_dump(&json!(7)).is_err());
}

#[test]
fn scalar_coercions_match_pydantic_lax_rules() {
    // `int` accepts a whole float, a bool and a numeric string.
    assert_eq!(
        video(json!({"fps": 30.0, "max_duration": true, "seed": "42"})),
        json!({"resolution": "1080p", "fps": 30, "max_duration": 1, "seed": 42})
    );
    // `int` rejects a fractional float and a fractional string.
    assert!(video_config_dump(&json!({"fps": 30.5})).is_err());
    assert!(video_config_dump(&json!({"fps": "30.5"})).is_err());
    // `str` does not accept numbers.
    assert!(video_config_dump(&json!({"ratio": 16})).is_err());
    // `bool` rejects out-of-range and unknown spellings.
    assert!(video_config_dump(&json!({"draft": 2})).is_err());
    assert!(video_config_dump(&json!({"draft": "maybe"})).is_err());
    assert!(video_config_dump(&json!({"draft": "YES"})).is_ok());
}

#[test]
fn non_mapping_nested_configs_are_rejected() {
    // pydantic validates a nested model from a mapping only. A positional JSON
    // array must not be read as a struct's field order.
    assert!(video_config_dump(&json!({"capabilities": []})).is_err());
    assert!(video_config_dump(&json!({"capabilities": [1, 2]})).is_err());
    assert!(image_config_dump(&json!({"capabilities": [true, 2]})).is_err());
    assert!(
        video_config_dump(
            &json!({"capabilities": {"aspect_ratios": [{"label": "a", "value": "b"}, [1, 2]]}})
        )
        .is_err()
    );
    assert!(video_config_dump(&json!({"capabilities": {"generation_modes": [[1, 2]]}})).is_err());
}

#[test]
fn integers_outside_the_signed_64_bit_range_are_rejected() {
    // pydantic rejects a float that does not fit an `Optional[int]` field.
    assert!(video_config_dump(&json!({"fps": 1e300})).is_err());
    assert!(video_config_dump(&json!({"fps": 9.223372036854776e18})).is_err());
    assert!(video_config_dump(&json!({"fps": 4.611686018427388e18})).is_ok());
}
