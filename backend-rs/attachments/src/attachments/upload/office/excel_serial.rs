// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The Python value formatting `openpyxl` and `knowledge_engine.excel` rely on.
//!
//! Cell values reach the attachment text through
//! `normalize_excel_value` -> `json.dumps(..., ensure_ascii=False)` ->
//! `format_excel_row_compact`, so the portable surface is wider than the
//! spreadsheet itself: an Excel serial number becomes a `datetime`/`date`/
//! `time`/`timedelta` and then its `isoformat()` (or `str(timedelta)`), and a
//! float keeps CPython's `repr` spelling. This module owns those primitives:
//!
//! - [`python_float_repr`]: shortest round-trip digits, with CPython's switch
//!   to scientific notation outside `1e-4 <= |value| < 1e16`;
//! - [`PythonDate`]: `date`/`datetime`/`time`/`timedelta` values rendered the
//!   way `isoformat()`/`str()` renders them;
//! - [`from_excel`]: `openpyxl.utils.datetime.from_excel`, including the
//!   1900 leap-year adjustment, the 1904 epoch and millisecond rounding;
//! - [`is_date_format`]/[`is_timedelta_format`]: the number-format scan that
//!   decides whether a numeric cell is a date at all.
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike};

/// A normalized Excel cell value that is not a plain string or number.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PythonDate {
    /// `datetime.date.isoformat()`.
    Date { year: i32, month: u32, day: u32 },
    /// `datetime.datetime.isoformat()`.
    DateTime(NaiveDateTime),
    /// `datetime.time.isoformat()`.
    Time(NaiveTime),
    /// `str(datetime.timedelta(...))`.
    TimeDelta { microseconds: i64 },
}

impl PythonDate {
    /// The textual form `normalize_excel_value` keeps.
    pub(crate) fn render(&self) -> String {
        match self {
            Self::Date { year, month, day } => format!("{year:04}-{month:02}-{day:02}"),
            Self::DateTime(value) => isoformat_datetime(*value),
            Self::Time(value) => isoformat_time(*value),
            Self::TimeDelta { microseconds } => render_timedelta(*microseconds),
        }
    }
}

/// `datetime.datetime.isoformat()`: seconds always, microseconds only when set.
pub(crate) fn isoformat_datetime(value: NaiveDateTime) -> String {
    let base = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        value.year(),
        value.month(),
        value.day(),
        value.hour(),
        value.minute(),
        value.second()
    );
    match value.nanosecond() / 1000 {
        0 => base,
        micros => format!("{base}.{micros:06}"),
    }
}

/// `datetime.time.isoformat()`.
pub(crate) fn isoformat_time(value: NaiveTime) -> String {
    let base = format!(
        "{:02}:{:02}:{:02}",
        value.hour(),
        value.minute(),
        value.second()
    );
    match value.nanosecond() / 1000 {
        0 => base,
        micros => format!("{base}.{micros:06}"),
    }
}

/// `str(datetime.timedelta)`: `[D day[s], ]HH:MM:SS[.ffffff]` over the
/// normalized (negative days, non-negative seconds) representation.
pub(crate) fn render_timedelta(microseconds: i64) -> String {
    const DAY: i64 = 86_400_000_000;
    let days = microseconds.div_euclid(DAY);
    let within_day = microseconds.rem_euclid(DAY);
    let hours = within_day / 3_600_000_000;
    let minutes = (within_day % 3_600_000_000) / 60_000_000;
    let seconds = (within_day % 60_000_000) / 1_000_000;
    let micros = within_day % 1_000_000;

    let mut out = String::new();
    if days != 0 {
        let plural = if days.abs() == 1 { "" } else { "s" };
        out.push_str(&format!("{days} day{plural}, "));
    }
    out.push_str(&format!("{hours}:{minutes:02}:{seconds:02}"));
    if micros > 0 {
        out.push_str(&format!(".{micros:06}"));
    }
    out
}

/// CPython's `repr(float)`.
///
/// `Rust`'s `{}` already prints the shortest round-tripping digits; CPython
/// prints the same digits but switches to scientific notation when the decimal
/// point sits outside `[-4, 16)` relative to the digit string.
pub(crate) fn python_float_repr(value: f64) -> String {
    if value.is_nan() {
        return "nan".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "inf" } else { "-inf" }.to_string();
    }
    if value == 0.0 {
        return if value.is_sign_negative() {
            "-0.0"
        } else {
            "0.0"
        }
        .to_string();
    }
    let negative = value < 0.0;
    let magnitude = value.abs();
    // `{:e}` renders `d[.ddd]e<exp>` with the shortest round-tripping digits.
    let scientific = format!("{magnitude:e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("scientific formatting always carries an exponent");
    let exponent: i32 = exponent.parse().expect("exponent is an integer");
    let digits: String = mantissa.chars().filter(|ch| *ch != '.').collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    // `decimal_point` is the count of digits before the point.
    let decimal_point = exponent + 1;
    let body = render_decimal(digits, decimal_point, exponent);
    if negative { format!("-{body}") } else { body }
}

fn render_decimal(digits: &str, decimal_point: i32, exponent: i32) -> String {
    let digit_count = digits.chars().count() as i32;
    if decimal_point <= -4 || decimal_point > 16 {
        let mantissa = if digits.len() == 1 {
            digits.to_string()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        let sign = if exponent < 0 { '-' } else { '+' };
        format!("{mantissa}e{sign}{:02}", exponent.abs())
    } else if decimal_point <= 0 {
        format!("0.{}{}", "0".repeat((-decimal_point) as usize), digits)
    } else if decimal_point >= digit_count {
        format!(
            "{}{}.0",
            digits,
            "0".repeat((decimal_point - digit_count) as usize)
        )
    } else {
        format!(
            "{}.{}",
            &digits[..decimal_point as usize],
            &digits[decimal_point as usize..]
        )
    }
}

/// `round()` for a float: ties go to the even integer, as in CPython.
pub(crate) fn round_half_even(value: f64) -> f64 {
    let floor = value.floor();
    let fraction = value - floor;
    // A tie rounds up only when the floor is odd.
    if fraction > 0.5 || (fraction == 0.5 && (floor / 2.0).fract() != 0.0) {
        floor + 1.0
    } else {
        floor
    }
}

/// `openpyxl.utils.datetime.WINDOWS_EPOCH`.
pub(crate) const WINDOWS_EPOCH: (i32, u32, u32) = (1899, 12, 30);
/// `openpyxl.utils.datetime.MAC_EPOCH`.
pub(crate) const MAC_EPOCH: (i32, u32, u32) = (1904, 1, 1);

/// `openpyxl.utils.datetime.from_excel(value, epoch, timedelta=...)`.
///
/// `windows_epoch` selects the 1899-12-30 base; a `timedelta` style keeps the
/// value as a duration instead.
pub(crate) fn from_excel(
    value: f64,
    windows_epoch: bool,
    as_timedelta: bool,
) -> Option<PythonDate> {
    if as_timedelta {
        // `timedelta(days=value)` accepts at most ±999_999_999 days and raises
        // `OverflowError` beyond that, which `openpyxl` renders as `#VALUE!`.
        if !value.is_finite() || value.abs() > 999_999_999.0 {
            return None;
        }
        // The source then re-rounds a nonzero microsecond remainder to
        // milliseconds.
        let micros = round_half_even(value * 86_400.0 * 1_000_000.0) as i64;
        let remainder = micros.rem_euclid(1_000_000);
        let normalized = if remainder == 0 {
            micros
        } else {
            let seconds = micros.div_euclid(1_000_000);
            let rounded = (round_half_even(remainder as f64 / 1_000.0) as i64) * 1_000;
            seconds
                .checked_mul(1_000_000)
                .and_then(|seconds| seconds.checked_add(rounded))?
        };
        return Some(PythonDate::TimeDelta {
            microseconds: normalized,
        });
    }

    let day = value.floor();
    let fraction = value - day;
    let milliseconds = round_half_even(fraction * 86_400.0 * 1_000.0);
    if (0.0..1.0).contains(&value) && milliseconds < 86_400_000.0 {
        return time_from_milliseconds(milliseconds);
    }
    let mut day = day;
    if value > 0.0 && value < 60.0 && windows_epoch {
        day += 1.0;
    }
    let epoch = if windows_epoch {
        WINDOWS_EPOCH
    } else {
        MAC_EPOCH
    };
    let base = NaiveDate::from_ymd_opt(epoch.0, epoch.1, epoch.2)?;
    // `datetime` raises `OverflowError`/`ValueError` outside 1..9999, which
    // `openpyxl` turns into `#VALUE!`; out-of-range serials must stay `None`.
    let date = base.checked_add_signed(Duration::try_days(day as i64)?)?;
    // The serial's fraction is whole milliseconds after the source's rounding.
    let offset = Duration::try_milliseconds(milliseconds as i64)?;
    let datetime = date.and_hms_opt(0, 0, 0)? + offset;
    if !(1..=9999).contains(&datetime.year()) {
        return None;
    }
    Some(PythonDate::DateTime(datetime))
}

/// `days_to_time(timedelta)`: a time-only serial becomes a `datetime.time`.
fn time_from_milliseconds(milliseconds: f64) -> Option<PythonDate> {
    let total_micros = (milliseconds as i64) * 1_000;
    let seconds = total_micros / 1_000_000;
    let micros = (total_micros % 1_000_000) as u32;
    Some(PythonDate::Time(
        NaiveTime::from_num_seconds_from_midnight_opt(seconds as u32, micros * 1_000)?,
    ))
}

/// `openpyxl.utils.datetime.from_ISO8601`, for the `t="d"` cell type.
pub(crate) fn from_iso8601(text: &str) -> Option<PythonDate> {
    if text.is_empty() {
        return None;
    }
    if let Some(duration) = from_iso_duration(text) {
        return Some(PythonDate::TimeDelta {
            microseconds: duration,
        });
    }
    // `ISO_REGEX`: the date, the `T` separator and the time are each optional,
    // so a bare `10:57:37` is a time and a bare `2026-10-16` is a date.
    let (date_part, time_part) = match text.split_once('T') {
        Some((date, time)) => (
            if date.is_empty() { None } else { Some(date) },
            if time.is_empty() { None } else { Some(time) },
        ),
        None => {
            if text.contains(':') {
                (None, Some(text))
            } else {
                (Some(text), None)
            }
        }
    };
    let date = match date_part {
        Some(value) if value.len() == 10 => {
            let year: i32 = value[0..4].parse().ok()?;
            let month: u32 = value[5..7].parse().ok()?;
            let day: u32 = value[8..10].parse().ok()?;
            NaiveDate::from_ymd_opt(year, month, day)
        }
        _ => None,
    };
    let time = match time_part {
        Some(value) => parse_iso_time(value)?,
        None => None,
    };
    match (date, time) {
        (Some(date), Some(time)) => Some(PythonDate::DateTime(date.and_time(time))),
        (Some(date), None) => Some(PythonDate::Date {
            year: date.year(),
            month: date.month(),
            day: date.day(),
        }),
        (None, Some(time)) => Some(PythonDate::Time(time)),
        (None, None) => None,
    }
}

/// `ISO_DURATION`: `PT<h>H<m>M<s>S`, the duration form strict OOXML writes.
fn from_iso_duration(text: &str) -> Option<i64> {
    let body = text.strip_prefix("PT")?;
    let mut rest = body;
    let mut microseconds: i64 = 0;
    let mut matched = false;
    for marker in ['H', 'M', 'S'] {
        let Some(end) = rest.find(marker) else {
            continue;
        };
        let value: f64 = rest[..end].parse().ok()?;
        let scale = match marker {
            'H' => 3_600_000_000.0,
            'M' => 60_000_000.0,
            _ => 1_000_000.0,
        };
        microseconds += (value * scale) as i64;
        matched = true;
        rest = &rest[end + marker.len_utf8()..];
    }
    if matched && rest.is_empty() {
        Some(microseconds)
    } else {
        None
    }
}

/// The `HH:MM[:SS[.fff]]Z` portion of an ISO 8601 timestamp.
fn parse_iso_time(value: &str) -> Option<Option<NaiveTime>> {
    let body = value.trim_end_matches('Z');
    let mut parts = body.split(':');
    let hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts.next()?.parse().ok()?;
    let (second, micros) = match parts.next() {
        Some(seconds) => {
            let (seconds, fraction) = match seconds.split_once('.') {
                Some((seconds, fraction)) => (seconds, Some(fraction)),
                None => (seconds, None),
            };
            let second: u32 = seconds.parse().ok()?;
            let micros = match fraction {
                Some(fraction) => {
                    let padded = format!("{fraction:0<3}");
                    padded[..3].parse::<u32>().ok()? * 1_000
                }
                None => 0,
            };
            (second, micros)
        }
        None => (0, 0),
    };
    Some(NaiveTime::from_hms_micro_opt(hour, minute, second, micros))
}

/// `openpyxl.styles.numbers.is_date_format`: the first format section carries
/// a date/time indicator that is neither escaped (`\_`) nor padding (`_`).
pub(crate) fn is_date_format(format: Option<&str>) -> bool {
    let Some(format) = format else {
        return false;
    };
    let first = format.split(';').next().unwrap_or("");
    let stripped = strip_literal_and_locale_groups(first);
    let mut previous: Option<char> = None;
    for ch in stripped.chars() {
        if matches!(
            ch,
            'd' | 'm' | 'h' | 'y' | 's' | 'D' | 'M' | 'H' | 'Y' | 'S'
        ) && !matches!(previous, Some('_') | Some('\\'))
        {
            return true;
        }
        previous = Some(ch);
    }
    false
}

/// `STRIP_RE`: quoted literals and bracketed locale sections, except the
/// elapsed-time markers `[h]`/`[hh]`/`[m]`/`[mm]`/`[s]`/`[ss]`.
fn strip_literal_and_locale_groups(format: &str) -> String {
    let mut out = String::with_capacity(format.len());
    let mut chars = format.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            for inner in chars.by_ref() {
                if inner == '"' {
                    break;
                }
            }
            continue;
        }
        if ch == '[' {
            let mut group = String::new();
            let mut closed = false;
            for inner in chars.by_ref() {
                if inner == ']' {
                    closed = true;
                    break;
                }
                group.push(inner);
            }
            if !closed || !is_elapsed_marker(&group) {
                continue;
            }
            out.push('[');
            out.push_str(&group);
            out.push(']');
            continue;
        }
        out.push(ch);
    }
    out
}

/// Whether a bracketed group is an elapsed time marker (`h`, `hh`, `mm`, ...).
fn is_elapsed_marker(group: &str) -> bool {
    matches!(
        group.to_ascii_lowercase().as_str(),
        "h" | "hh" | "m" | "mm" | "s" | "ss"
    )
}

/// `openpyxl.styles.numbers.is_timedelta_format`: every suffix in
/// `TIMEDELTA_RE` is optional, so an elapsed-time marker anywhere in the first
/// format section matches.
pub(crate) fn is_timedelta_format(format: Option<&str>) -> bool {
    let Some(format) = format else {
        return false;
    };
    let first = format.split(';').next().unwrap_or("");
    let mut chars = first.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '[' {
            continue;
        }
        let mut group = String::new();
        let mut closed = false;
        for inner in chars.by_ref() {
            if inner == ']' {
                closed = true;
                break;
            }
            group.push(inner);
        }
        if closed && is_elapsed_marker(&group) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_keep_cpython_spelling() {
        assert_eq!(python_float_repr(7.583333333333333), "7.583333333333333");
        assert_eq!(python_float_repr(0.0001), "0.0001");
        assert_eq!(python_float_repr(1e-5), "1e-05");
        assert_eq!(python_float_repr(1e16), "1e+16");
        assert_eq!(python_float_repr(1e15), "1000000000000000.0");
        assert_eq!(python_float_repr(-2.5), "-2.5");
        assert_eq!(python_float_repr(0.0), "0.0");
        assert_eq!(python_float_repr(-0.0), "-0.0");
        assert_eq!(python_float_repr(f64::INFINITY), "inf");
        assert_eq!(python_float_repr(f64::NAN), "nan");
    }

    #[test]
    fn timedeltas_render_like_python() {
        assert_eq!(render_timedelta(0), "0:00:00");
        assert_eq!(render_timedelta(1_500_000), "0:00:01.500000");
        assert_eq!(render_timedelta(90_061_000_000), "1 day, 1:01:01");
        assert_eq!(render_timedelta(-86_400_000_000), "-1 day, 0:00:00");
        assert_eq!(render_timedelta(-129_600_000_000), "-2 days, 12:00:00");
    }

    #[test]
    fn excel_serials_follow_openpyxl() {
        let datetime = from_excel(45000.5, true, false).expect("serial converts");
        assert_eq!(datetime.render(), "2023-03-15T12:00:00");
        // The 1900 leap-year adjustment applies below serial 60.
        let leap = from_excel(58.999, true, false).expect("serial converts");
        assert_eq!(leap.render(), "1900-02-27T23:58:33.600000");
        // A fraction-only serial is a time, even in a 1904 workbook.
        let time = from_excel(0.0, false, false).expect("serial converts");
        assert_eq!(time.render(), "00:00:00");
        let elapsed = from_excel(1.5, true, true).expect("serial converts");
        assert_eq!(elapsed.render(), "1 day, 12:00:00");
        let mac = from_excel(0.0, false, true).expect("serial converts");
        assert_eq!(mac.render(), "0:00:00");
        // `datetime` rejects years outside 1..9999, and the source renders the
        // resulting `#VALUE!` cell instead of a date.
        assert_eq!(from_excel(1e12, false, false), None);
        assert_eq!(from_excel(4_000_000.0, false, false), None);
        assert_eq!(from_excel(1e12, false, true), None);
    }

    #[test]
    fn iso_8601_values_are_understood() {
        assert_eq!(
            from_iso8601("2026-10-16T10:57:37").map(|value| value.render()),
            Some("2026-10-16T10:57:37".to_string())
        );
        assert_eq!(
            from_iso8601("2026-10-16").map(|value| value.render()),
            Some("2026-10-16".to_string())
        );
        assert_eq!(
            from_iso8601("10:57:37").map(|value| value.render()),
            Some("10:57:37".to_string())
        );
        assert_eq!(
            from_iso8601("PT1H30M").map(|value| value.render()),
            Some("1:30:00".to_string())
        );
        assert_eq!(
            from_iso8601("2026-10-16T10:57:37.5").map(|value| value.render()),
            Some("2026-10-16T10:57:37.500000".to_string())
        );
        assert!(from_iso8601("not a date").is_none());
    }

    #[test]
    fn number_formats_decide_which_cells_are_dates() {
        for format in [
            "yyyy-mm-dd",
            "mm-dd-yy",
            "h:mm",
            "m/d/yy h:mm",
            "[h]:mm:ss",
            "mm:ss",
            "yyyy\\-mm\\-dd",
            "[$-409]mmm d, yyyy",
        ] {
            assert!(is_date_format(Some(format)), "{format} is a date format");
        }
        for format in ["General", "0.00", "0.00E+00", "#,##0", "@", "\"days\"0"] {
            assert!(!is_date_format(Some(format)), "{format} is not a date");
        }
        assert!(!is_date_format(None));
        assert!(is_timedelta_format(Some("[h]:mm:ss")));
        assert!(is_timedelta_format(Some("[ss].0")));
        assert!(!is_timedelta_format(Some("h:mm:ss")));
        assert!(!is_timedelta_format(Some("mm-dd-yy")));
    }

    #[test]
    fn ties_round_to_even() {
        assert_eq!(round_half_even(0.5), 0.0);
        assert_eq!(round_half_even(1.5), 2.0);
        assert_eq!(round_half_even(2.5), 2.0);
        assert_eq!(round_half_even(-0.5), -0.0);
    }
}
