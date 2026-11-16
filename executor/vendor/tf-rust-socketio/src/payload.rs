use bytes::Bytes;

/// A type which represents a `payload` in the `socket.io` context.
/// A payload could either be of the type `Payload::Binary`, which holds
/// data in the [`Bytes`] type that represents the payload or of the type
/// `Payload::String` which holds a [`std::string::String`]. The enum is
/// used for both representing data that's send and data that's received.
/// The optional `i32` field represents the ack ID if this payload
/// requires acknowledgment from the server.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Payload {
    Binary(Bytes, Option<i32>),
    Text(Vec<serde_json::Value>, Option<i32>),
    #[deprecated = "Use `Payload::Text` instead. Continue existing behavior with: Payload::from(String)"]
    /// String that is sent as JSON if this is a JSON string, or as a raw string if it isn't
    String(String, Option<i32>),
}

impl Payload {
    pub(crate) fn string_to_value(string: String) -> serde_json::Value {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&string) {
            value
        } else {
            serde_json::Value::String(string)
        }
    }
}

impl From<&str> for Payload {
    fn from(string: &str) -> Self {
        Payload::from(string.to_owned())
    }
}

impl Payload {
    /// 创建一个带ack_id的payload
    pub fn with_ack_id<T: Into<Self>>(payload: T, ack_id: i32) -> Self {
        #[allow(deprecated)]
        match payload.into() {
            Payload::Binary(data, _) => Payload::Binary(data, Some(ack_id)),
            Payload::Text(data, _) => Payload::Text(data, Some(ack_id)),
            Payload::String(data, _) => Payload::String(data, Some(ack_id)),
        }
    }

    /// 获取payload的ack_id
    pub fn ack_id(&self) -> Option<i32> {
        #[allow(deprecated)]
        match self {
            Payload::Binary(_, ack_id) => *ack_id,
            Payload::Text(_, ack_id) => *ack_id,
            Payload::String(_, ack_id) => *ack_id,
        }
    }

    /// 设置payload的ack_id
    pub fn set_ack_id(&mut self, ack_id: Option<i32>) {
        #[allow(deprecated)]
        match self {
            Payload::Binary(_, id) => *id = ack_id,
            Payload::Text(_, id) => *id = ack_id,
            Payload::String(_, id) => *id = ack_id,
        }
    }

    /// 获取payload的数据部分（不包含ack_id）
    pub fn data(&self) -> PayloadData<'_> {
        #[allow(deprecated)]
        match self {
            Payload::Binary(data, _) => PayloadData::Binary(data),
            Payload::Text(data, _) => PayloadData::Text(data),
            Payload::String(data, _) => PayloadData::String(data),
        }
    }
}

/// Payload的数据部分（不包含ack_id）
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum PayloadData<'a> {
    Binary(&'a Bytes),
    Text(&'a Vec<serde_json::Value>),
    String(&'a String),
}

impl From<String> for Payload {
    fn from(string: String) -> Self {
        Self::Text(vec![Payload::string_to_value(string)], None)
    }
}

impl From<Vec<String>> for Payload {
    fn from(arr: Vec<String>) -> Self {
        Self::Text(
            arr.into_iter().map(Payload::string_to_value).collect(),
            None,
        )
    }
}

impl From<Vec<serde_json::Value>> for Payload {
    fn from(values: Vec<serde_json::Value>) -> Self {
        Self::Text(values, None)
    }
}

impl From<serde_json::Value> for Payload {
    fn from(value: serde_json::Value) -> Self {
        Self::Text(vec![value], None)
    }
}

impl From<Vec<u8>> for Payload {
    fn from(val: Vec<u8>) -> Self {
        Self::Binary(Bytes::from(val), None)
    }
}

impl From<&'static [u8]> for Payload {
    fn from(val: &'static [u8]) -> Self {
        Self::Binary(Bytes::from_static(val), None)
    }
}

impl From<Bytes> for Payload {
    fn from(bytes: Bytes) -> Self {
        Self::Binary(bytes, None)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn test_from_string() {
        let sut = Payload::from("foo ™");

        assert_eq!(
            Payload::Text(vec![serde_json::Value::String(String::from("foo ™"))], None),
            sut
        );

        let sut = Payload::from(String::from("foo ™"));
        assert_eq!(
            Payload::Text(vec![serde_json::Value::String(String::from("foo ™"))], None),
            sut
        );

        let sut = Payload::from(json!("foo ™"));
        assert_eq!(
            Payload::Text(vec![serde_json::Value::String(String::from("foo ™"))], None),
            sut
        );
    }

    #[test]
    fn test_from_multiple_strings() {
        let input = vec![
            "one".to_owned(),
            "two".to_owned(),
            json!(["foo", "bar"]).to_string(),
        ];

        assert_eq!(
            Payload::Text(
                vec![
                    serde_json::Value::String(String::from("one")),
                    serde_json::Value::String(String::from("two")),
                    json!(["foo", "bar"])
                ],
                None
            ),
            Payload::from(input)
        );
    }

    #[test]
    fn test_from_multiple_json() {
        let input = vec![json!({"foo": "bar"}), json!("foo"), json!(["foo", "bar"])];

        assert_eq!(
            Payload::Text(input.clone(), None),
            Payload::from(input.clone())
        );
    }

    #[test]
    fn test_from_json() {
        let json = json!({
            "foo": "bar"
        });
        let sut = Payload::from(json.clone());

        assert_eq!(Payload::Text(vec![json.clone()], None), sut);

        // From JSON encoded string
        let sut = Payload::from(json.to_string());

        assert_eq!(Payload::Text(vec![json], None), sut);
    }

    #[test]
    fn test_from_binary() {
        let sut = Payload::from(vec![1, 2, 3]);
        assert_eq!(Payload::Binary(Bytes::from_static(&[1, 2, 3]), None), sut);

        let sut = Payload::from(&[1_u8, 2_u8, 3_u8][..]);
        assert_eq!(Payload::Binary(Bytes::from_static(&[1, 2, 3]), None), sut);

        let sut = Payload::from(Bytes::from_static(&[1, 2, 3]));
        assert_eq!(Payload::Binary(Bytes::from_static(&[1, 2, 3]), None), sut);
    }

    #[test]
    fn test_payload_with_ack_id() {
        let payload = Payload::from("test");
        let payload_with_ack = Payload::with_ack_id(payload, 123);

        assert_eq!(payload_with_ack.ack_id(), Some(123));

        match payload_with_ack {
            Payload::Text(data, Some(ack_id)) => {
                assert_eq!(data, vec![serde_json::Value::String("test".to_string())]);
                assert_eq!(ack_id, 123);
            }
            _ => panic!("Expected Text payload with ack_id"),
        }
    }

    #[test]
    fn test_payload_set_ack_id() {
        let mut payload = Payload::from(vec![1, 2, 3]);
        assert_eq!(payload.ack_id(), None);

        payload.set_ack_id(Some(456));
        assert_eq!(payload.ack_id(), Some(456));

        payload.set_ack_id(None);
        assert_eq!(payload.ack_id(), None);
    }

    #[test]
    fn test_payload_data() {
        let payload = Payload::with_ack_id(json!("test"), 789);

        match payload.data() {
            PayloadData::Text(data) => {
                assert_eq!(data, &vec![json!("test")]);
            }
            _ => panic!("Expected Text data"),
        }

        // Original payload still has ack_id
        assert_eq!(payload.ack_id(), Some(789));
    }
}
