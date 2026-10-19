//! The PyYAML safe-loader scalar and mapping rules used by resource files.
use std::collections::HashMap;

use anyhow::{Result, bail, ensure};
use serde_json::{Map, Value};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

const MAX_NODES: usize = 65536;
const MAX_EXPANDED_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct Node {
    value: Value,
    merge: bool,
    size: usize,
}
impl Node {
    fn new(value: Value) -> Self {
        let size = match &value {
            Value::String(s) => s.len(),
            _ => 8,
        };
        Self {
            value,
            merge: false,
            size,
        }
    }
}

enum Frame {
    Sequence {
        anchor: usize,
        items: Vec<Value>,
        size: usize,
    },
    Mapping {
        anchor: usize,
        pairs: Vec<(Node, Node)>,
        key: Option<Node>,
        size: usize,
    },
}

#[derive(Default)]
struct Loader {
    stack: Vec<Frame>,
    anchors: HashMap<usize, Node>,
    root: Option<Node>,
    docs: Vec<Value>,
    nodes: usize,
    error: Option<anyhow::Error>,
}

pub(super) fn documents(source: &str) -> Result<Vec<Value>> {
    let mut loader = Loader::default();
    Parser::new(source.chars()).load(&mut loader, true)?;
    if let Some(error) = loader.error {
        return Err(error);
    }
    Ok(loader.docs)
}

impl MarkedEventReceiver for Loader {
    fn on_event(&mut self, event: Event, _marker: Marker) {
        if self.error.is_some() {
            return;
        }
        if let Err(error) = self.event(event) {
            self.error = Some(error);
        }
    }
}

impl Loader {
    fn event(&mut self, event: Event) -> Result<()> {
        self.nodes += 1;
        ensure!(
            self.nodes <= MAX_NODES && self.stack.len() <= 64,
            "default resource YAML too complex"
        );
        match event {
            Event::DocumentStart => {
                self.anchors.clear();
                self.root = None;
            }
            Event::DocumentEnd => {
                self.docs
                    .push(self.root.take().map_or(Value::Null, |n| n.value));
            }
            Event::SequenceStart(anchor, tag) => {
                container_tag(tag.as_ref(), "seq")?;
                self.stack.push(Frame::Sequence {
                    anchor,
                    items: Vec::new(),
                    size: 0,
                });
            }
            Event::MappingStart(anchor, tag) => {
                container_tag(tag.as_ref(), "map")?;
                self.stack.push(Frame::Mapping {
                    anchor,
                    pairs: Vec::new(),
                    key: None,
                    size: 0,
                });
            }
            Event::Scalar(text, style, anchor, tag) => {
                let plain = style == TScalarStyle::Plain;
                let mut node = Node::new(scalar(&text, plain, tag.as_ref())?);
                node.merge = (plain && text == "<<" && tag.is_none())
                    || tag.as_ref().is_some_and(|t| t.suffix == "merge");
                self.insert(node, anchor)?;
            }
            Event::Alias(anchor) => {
                let node = self
                    .anchors
                    .get(&anchor)
                    .ok_or_else(|| anyhow::anyhow!("recursive or undefined YAML alias"))?
                    .clone();
                self.insert(node, 0)?;
            }
            Event::SequenceEnd => {
                let Some(Frame::Sequence {
                    anchor,
                    items,
                    size,
                }) = self.stack.pop()
                else {
                    bail!("invalid YAML sequence")
                };
                self.insert(
                    Node {
                        value: Value::Array(items),
                        merge: false,
                        size,
                    },
                    anchor,
                )?;
            }
            Event::MappingEnd => {
                let Some(Frame::Mapping {
                    anchor,
                    pairs,
                    key: None,
                    size,
                }) = self.stack.pop()
                else {
                    bail!("invalid YAML mapping")
                };
                self.insert(
                    Node {
                        value: mapping(pairs)?,
                        merge: false,
                        size,
                    },
                    anchor,
                )?;
            }
            _ => (),
        }
        Ok(())
    }

    fn insert(&mut self, node: Node, anchor: usize) -> Result<()> {
        ensure!(
            node.size <= MAX_EXPANDED_BYTES,
            "default resource alias expansion too large"
        );
        if anchor != 0 {
            self.anchors.insert(anchor, node.clone());
        }
        match self.stack.last_mut() {
            Some(Frame::Sequence { items, size, .. }) => {
                *size = size
                    .checked_add(node.size)
                    .ok_or_else(|| anyhow::anyhow!("YAML size overflow"))?;
                ensure!(
                    *size <= MAX_EXPANDED_BYTES,
                    "default resource YAML too large"
                );
                items.push(node.value);
            }
            Some(Frame::Mapping {
                pairs, key, size, ..
            }) => {
                *size = size
                    .checked_add(node.size)
                    .ok_or_else(|| anyhow::anyhow!("YAML size overflow"))?;
                ensure!(
                    *size <= MAX_EXPANDED_BYTES,
                    "default resource YAML too large"
                );
                if let Some(key_node) = key.take() {
                    pairs.push((key_node, node));
                } else {
                    *key = Some(node);
                }
            }
            None => self.root = Some(node),
        }
        Ok(())
    }
}

fn container_tag(tag: Option<&Tag>, expected: &str) -> Result<()> {
    ensure!(
        tag.is_none_or(|t| t.handle == "tag:yaml.org,2002:" && t.suffix == expected),
        "unsupported safe YAML container tag"
    );
    Ok(())
}

fn mapping(pairs: Vec<(Node, Node)>) -> Result<Value> {
    let mut map = Map::new();
    for (_, node) in pairs.iter().filter(|(key, _)| key.merge) {
        match &node.value {
            Value::Object(other) => map.extend(other.clone()),
            Value::Array(maps) => {
                for other in maps.iter().rev() {
                    map.extend(
                        other
                            .as_object()
                            .ok_or_else(|| anyhow::anyhow!("invalid YAML merge map"))?
                            .clone(),
                    );
                }
            }
            _ => bail!("invalid YAML merge value"),
        }
    }
    for (key, value) in pairs.into_iter().filter(|(key, _)| !key.merge) {
        let key = match key.value {
            Value::String(s) => s,
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            Value::Null => "null".into(),
            _ => bail!("unhashable safe YAML mapping key"),
        };
        map.insert(key, value.value);
    }
    Ok(Value::Object(map))
}

fn scalar(text: &str, plain: bool, tag: Option<&Tag>) -> Result<Value> {
    let explicit = tag
        .map(|tag| {
            ensure!(tag.handle == "tag:yaml.org,2002:", "unknown safe YAML tag");
            Ok(tag.suffix.as_str())
        })
        .transpose()?;
    if explicit == Some("str") || (!plain && explicit.is_none()) {
        return Ok(Value::String(text.into()));
    }
    if matches!(explicit, Some("null" | "merge")) {
        return Ok(if explicit == Some("merge") {
            Value::String(text.into())
        } else {
            Value::Null
        });
    }
    if explicit.is_none() && matches!(text, "" | "~" | "null" | "Null" | "NULL") {
        return Ok(Value::Null);
    }
    let boolean = match text {
        "yes" | "Yes" | "YES" | "true" | "True" | "TRUE" | "on" | "On" | "ON" => Some(true),
        "no" | "No" | "NO" | "false" | "False" | "FALSE" | "off" | "Off" | "OFF" => Some(false),
        _ => None,
    };
    if explicit == Some("bool") {
        return boolean
            .map(Value::Bool)
            .ok_or_else(|| anyhow::anyhow!("invalid YAML boolean"));
    }
    if explicit.is_none()
        && let Some(boolean) = boolean
    {
        return Ok(Value::Bool(boolean));
    }
    if (explicit == Some("int") || explicit.is_none() && implicit_integer(text))
        && let Some(integer) = integer(text)
    {
        return Ok(Value::Number(integer.into()));
    }
    if explicit == Some("int") {
        bail!("invalid YAML integer");
    }
    let normalized = text.replace('_', "");
    let looks_float = implicit_float(text);
    if explicit == Some("float") || explicit.is_none() && looks_float {
        let parsed = if normalized.contains(':') {
            sexagesimal(&normalized)
        } else {
            normalized.parse::<f64>().ok()
        };
        if let Some(number) = parsed.and_then(serde_json::Number::from_f64) {
            return Ok(Value::Number(number));
        }
        if explicit == Some("float") {
            bail!("invalid JSON-compatible YAML float");
        }
    }
    ensure!(explicit.is_none(), "unsupported safe YAML scalar tag");
    Ok(Value::String(text.into()))
}

fn implicit_integer(text: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$").expect("PyYAML integer resolver")).is_match(text)
}

fn implicit_float(text: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$").expect("PyYAML float resolver")).is_match(text)
}

fn integer(text: &str) -> Option<i64> {
    let compact = text.replace('_', "");
    let (negative, value) = compact.strip_prefix('-').map_or(
        (false, compact.strip_prefix('+').unwrap_or(&compact)),
        |s| (true, s),
    );
    let magnitude = if let Some(value) = value.strip_prefix("0b") {
        i128::from_str_radix(value, 2).ok()?
    } else if let Some(value) = value.strip_prefix("0x") {
        i128::from_str_radix(value, 16).ok()?
    } else if value.starts_with('0') && value.len() > 1 {
        i128::from_str_radix(&value[1..], 8).ok()?
    } else if value.contains(':') && !value.starts_with('0') {
        let mut total = 0_i128;
        for (index, part) in value.split(':').enumerate() {
            let number: i128 = part.parse().ok()?;
            if index > 0 && !(0..60).contains(&number) {
                return None;
            }
            total = total.checked_mul(60)?.checked_add(number)?;
        }
        total
    } else {
        value.parse::<i128>().ok()?
    };
    i64::try_from(if negative { -magnitude } else { magnitude }).ok()
}

fn sexagesimal(text: &str) -> Option<f64> {
    let (negative, value) = text
        .strip_prefix('-')
        .map_or((false, text.strip_prefix('+').unwrap_or(text)), |s| {
            (true, s)
        });
    let mut total = 0.0;
    for (index, part) in value.split(':').enumerate() {
        let number: f64 = part.parse().ok()?;
        if index > 0 && !(0.0..60.0).contains(&number) {
            return None;
        }
        total = total * 60.0 + number;
    }
    Some(if negative { -total } else { total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn safe_yaml_uses_source_boolean_octal_and_exponent_rules() {
        let docs = documents("flag: yes\nquoted: 'yes'\ncount: 010\nnot_octal: 09\nfloat: 1.0e+2\ntext: 1.0e2\nseconds: 1:02\n").unwrap();
        assert_eq!(
            docs,
            [
                json!({"flag":true,"quoted":"yes","count":8,"not_octal":"09","float":100.0,"text":"1.0e2","seconds":62})
            ]
        );
    }

    #[test]
    fn safe_yaml_merges_aliases_and_keeps_the_last_duplicate_value() {
        let docs = documents("base: &base {enabled: on, count: 1}\nresource: {count: 3, <<: *base, repeated: first, repeated: second}\n").unwrap();
        assert_eq!(
            docs[0]["resource"],
            json!({"enabled":true,"count":3,"repeated":"second"})
        );
    }
}
