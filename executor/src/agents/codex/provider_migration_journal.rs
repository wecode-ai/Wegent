// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde::de::{SeqAccess, Visitor};

#[derive(Deserialize)]
struct Version {
    version: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyJournal {
    version: u32,
    complete: bool,
    pending_from: usize,
    #[serde(deserialize_with = "compact_entries")]
    entries: Vec<Entry>,
    #[serde(default)]
    index_routes: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyEntry {
    path: PathBuf,
    thread_id: String,
    provider: String,
    before: String,
    after: String,
}

// Read one legacy snapshot at a time. A large base instruction must never be
// duplicated for every session in memory or copied into the replacement journal.
fn compact_entries<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Entry>, D::Error> {
    struct Entries;
    impl<'de> Visitor<'de> for Entries {
        type Value = Vec<Entry>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("legacy Codex migration entries")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut entries = Vec::new();
            while let Some(old) = seq.next_element::<LegacyEntry>()? {
                let entry = plan_entry(old.path, &old.before).map_err(serde::de::Error::custom)?;
                if entry.thread_id != old.thread_id
                    || entry.provider != old.provider
                    || rewrite_metadata(&old.before).map_err(serde::de::Error::custom)? != old.after
                {
                    return Err(serde::de::Error::custom(
                        "Codex migration may only change the provider identity",
                    ));
                }
                entries.push(entry);
            }
            Ok(entries)
        }
    }
    d.deserialize_seq(Entries)
}

pub(super) fn load(path: &Path) -> Result<(Journal, bool), String> {
    if !path.try_exists().map_err(error)? {
        return Ok((
            Journal {
                version: JOURNAL_VERSION,
                ..Journal::default()
            },
            false,
        ));
    }
    let version: Version =
        serde_json::from_reader(BufReader::new(File::open(path).map_err(error)?)).map_err(error)?;
    let input = BufReader::new(File::open(path).map_err(error)?);
    match version.version {
        JOURNAL_VERSION => Ok((serde_json::from_reader(input).map_err(error)?, false)),
        2 => {
            let old: LegacyJournal = serde_json::from_reader(input).map_err(error)?;
            if old.version != 2 {
                return Err("Invalid Codex provider migration journal version".into());
            }
            Ok((
                Journal {
                    version: JOURNAL_VERSION,
                    complete: old.complete,
                    pending_from: old.pending_from,
                    entries: old.entries,
                    index_routes: old.index_routes,
                },
                true,
            ))
        }
        _ => Err("Unsupported Codex provider migration journal version".into()),
    }
}
