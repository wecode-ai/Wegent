// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Pillow's JPEG factory recognizes multi-picture MPF indexes as MPO images.

pub(super) fn format(bytes: &[u8]) -> &'static str {
    let mut offset = 2usize;
    let mut mpf = None;
    let mut ultra_hdr = false;
    while bytes.get(offset) == Some(&0xff) {
        let Some(&marker) = bytes.get(offset + 1) else {
            break;
        };
        if matches!(marker, 0xda | 0xd9) {
            break;
        }
        if marker == 0xff {
            offset += 1;
            continue;
        }
        let Some(length) = bytes.get(offset + 2..offset + 4) else {
            break;
        };
        let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
        if length < 2 {
            break;
        }
        let Some(payload) = bytes.get(offset + 4..offset + 2 + length) else {
            break;
        };
        match marker {
            0xe1 => {
                ultra_hdr |= payload
                    .windows(16)
                    .any(|value| value == b" hdrgm:Version=\"")
            }
            0xe2 => {
                if let Some(tiff) = payload.strip_prefix(b"MPF\0") {
                    mpf = Some(tiff);
                }
            }
            _ => {}
        }
        offset += 2 + length;
    }
    if !ultra_hdr && mpf.is_some_and(multiple_pictures) {
        "MPO"
    } else {
        "JPEG"
    }
}

struct Tiff<'a> {
    bytes: &'a [u8],
    little_endian: bool,
}

impl Tiff<'_> {
    fn short(&self, offset: usize) -> Option<u16> {
        let data = self.bytes.get(offset..offset.checked_add(2)?)?;
        let bytes = [data[0], data[1]];
        Some(if self.little_endian {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    }

    fn long(&self, offset: usize) -> Option<u32> {
        let data = self.bytes.get(offset..offset.checked_add(4)?)?;
        let bytes = [data[0], data[1], data[2], data[3]];
        Some(if self.little_endian {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    }
}

fn multiple_pictures(bytes: &[u8]) -> bool {
    read_index(bytes).unwrap_or(false)
}

/// `JpegImagePlugin._getmp`: require a readable image count and JPEG MP entries.
fn read_index(bytes: &[u8]) -> Option<bool> {
    let little_endian = match bytes.get(..4)? {
        b"II\x2a\0" => true,
        b"MM\0\x2a" => false,
        _ => return None,
    };
    let tiff = Tiff {
        bytes,
        little_endian,
    };
    let directory = usize::try_from(tiff.long(4)?).ok()?;
    let count = usize::from(tiff.short(directory)?);
    let mut pictures = None;
    let mut entries = None;
    for index in 0..count {
        let entry = directory
            .checked_add(2)?
            .checked_add(index.checked_mul(12)?)?;
        match tiff.short(entry)? {
            0xb001 if tiff.long(entry + 4)? == 1 => {
                pictures = match tiff.short(entry + 2)? {
                    3 => Some(u32::from(tiff.short(entry + 8)?)),
                    4 => Some(tiff.long(entry + 8)?),
                    _ => None,
                };
            }
            0xb002 if tiff.short(entry + 2)? == 7 => {
                entries = Some((tiff.long(entry + 4)?, tiff.long(entry + 8)?));
            }
            _ => {}
        }
    }
    let pictures = usize::try_from(pictures?).ok()?;
    let (length, offset) = entries?;
    let length = usize::try_from(length).ok()?;
    let offset = usize::try_from(offset).ok()?;
    let needed = pictures.checked_mul(16)?;
    if length < needed || bytes.get(offset..offset.checked_add(needed)?).is_none() {
        return None;
    }
    for index in 0..pictures {
        let attribute = tiff.long(offset + index * 16)?;
        if attribute & (7 << 24) != 0 {
            return None;
        }
    }
    Some(pictures > 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mpf_jpeg(pictures: u32) -> Vec<u8> {
        let mut tiff = b"II\x2a\0\x08\0\0\0\x02\0".to_vec();
        for (tag, kind, count, value) in [
            (0xb001u16, 4u16, 1u32, pictures),
            (0xb002, 7, pictures * 16, 38),
        ] {
            tiff.extend(tag.to_le_bytes());
            tiff.extend(kind.to_le_bytes());
            tiff.extend(count.to_le_bytes());
            tiff.extend(value.to_le_bytes());
        }
        tiff.extend([0; 4]);
        tiff.resize(tiff.len() + pictures as usize * 16, 0);
        let payload = [b"MPF\0".as_slice(), &tiff].concat();
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe2];
        bytes.extend(u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
        bytes.extend(payload);
        bytes.extend([0xff, 0xda]);
        bytes
    }

    #[test]
    fn multiple_jpeg_frames_report_mpo_but_single_and_malformed_indexes_do_not() {
        assert_eq!(format(&mpf_jpeg(2)), "MPO");
        assert_eq!(format(&mpf_jpeg(1)), "JPEG");
        let mut truncated = mpf_jpeg(2);
        truncated.truncate(48);
        assert_eq!(format(&truncated), "JPEG");
    }

    #[test]
    fn ultra_hdr_keeps_the_base_jpeg_format_as_in_pillow() {
        let mut bytes = mpf_jpeg(2);
        bytes.truncate(bytes.len() - 2);
        let xmp = b"<rdf hdrgm:Version=\"1.0\"/>";
        bytes.extend([0xff, 0xe1]);
        bytes.extend(u16::try_from(xmp.len() + 2).unwrap().to_be_bytes());
        bytes.extend(xmp);
        bytes.extend([0xff, 0xda]);
        assert_eq!(format(&bytes), "JPEG");
    }
}
