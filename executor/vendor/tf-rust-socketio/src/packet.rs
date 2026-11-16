use crate::error::{Error, Result};
use crate::{Event, Payload};
use bytes::Bytes;
use serde::de::IgnoredAny;

use std::convert::TryFrom;
use std::fmt::Write;
use std::str::from_utf8 as str_from_utf8;

/// An enumeration of the different `Packet` types in the `socket.io` protocol.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum PacketId {
    Connect = 0,
    Disconnect = 1,
    Event = 2,
    Ack = 3,
    ConnectError = 4,
    BinaryEvent = 5,
    BinaryAck = 6,
}

/// A packet which gets sent or received during in the `socket.io` protocol.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Packet {
    pub packet_type: PacketId,
    pub nsp: String,
    pub data: Option<String>,
    pub id: Option<i32>,
    pub attachment_count: u8,
    pub attachments: Option<Vec<Bytes>>,
}

impl Packet {
    /// Returns a packet for a payload, could be used for both binary and non binary
    /// events and acks. Convenience method.
    #[inline]
    pub(crate) fn new_from_payload(
        payload: Payload,
        event: Event,
        nsp: &str,
        id: Option<i32>,
    ) -> Result<Packet> {
        match payload {
            Payload::Binary(bin_data, _) => Ok(Packet::new(
                if id.is_some() {
                    PacketId::BinaryAck
                } else {
                    PacketId::BinaryEvent
                },
                nsp.to_owned(),
                Some(serde_json::Value::String(event.into()).to_string()),
                id,
                1,
                Some(vec![bin_data]),
            )),
            #[allow(deprecated)]
            Payload::String(str_data, _) => {
                let payload = if serde_json::from_str::<IgnoredAny>(&str_data).is_ok() {
                    format!("[\"{event}\",{str_data}]")
                } else {
                    format!("[\"{event}\",\"{str_data}\"]")
                };

                Ok(Packet::new(
                    PacketId::Event,
                    nsp.to_owned(),
                    Some(payload),
                    id,
                    0,
                    None,
                ))
            }
            Payload::Text(mut data, _) => {
                let mut payload_args = vec![serde_json::Value::String(event.to_string())];
                payload_args.append(&mut data);
                drop(data);

                let payload = serde_json::Value::Array(payload_args).to_string();

                Ok(Packet::new(
                    PacketId::Event,
                    nsp.to_owned(),
                    Some(payload),
                    id,
                    0,
                    None,
                ))
            }
        }
    }

    #[inline]
    pub(crate) fn ack_from_payload(
        payload: Payload,
        nsp: &str,
        ack_id: Option<i32>,
    ) -> Result<Packet> {
        match payload {
            Payload::Binary(bin_data, _) => Ok(Packet::new(
                PacketId::BinaryAck,
                nsp.to_owned(),
                None,
                ack_id,
                1,
                Some(vec![bin_data]),
            )),
            #[allow(deprecated)]
            Payload::String(str_data, _) => {
                let payload = if serde_json::from_str::<IgnoredAny>(&str_data).is_ok() {
                    format!("[{str_data}]")
                } else {
                    format!("[\"{str_data}\"]")
                };

                Ok(Packet::new(
                    PacketId::Ack,
                    nsp.to_owned(),
                    Some(payload),
                    ack_id,
                    0,
                    None,
                ))
            }
            Payload::Text(data, _) => {
                let payload = serde_json::Value::Array(data).to_string();

                Ok(Packet::new(
                    PacketId::Ack,
                    nsp.to_owned(),
                    Some(payload),
                    ack_id,
                    0,
                    None,
                ))
            }
        }
    }
}

impl Default for Packet {
    fn default() -> Self {
        Self {
            packet_type: PacketId::Event,
            nsp: String::from("/"),
            data: None,
            id: None,
            attachment_count: 0,
            attachments: None,
        }
    }
}

impl TryFrom<u8> for PacketId {
    type Error = Error;
    fn try_from(b: u8) -> Result<Self> {
        PacketId::try_from(b as char)
    }
}

impl TryFrom<char> for PacketId {
    type Error = Error;
    fn try_from(b: char) -> Result<Self> {
        match b {
            '0' => Ok(PacketId::Connect),
            '1' => Ok(PacketId::Disconnect),
            '2' => Ok(PacketId::Event),
            '3' => Ok(PacketId::Ack),
            '4' => Ok(PacketId::ConnectError),
            '5' => Ok(PacketId::BinaryEvent),
            '6' => Ok(PacketId::BinaryAck),
            _ => Err(Error::InvalidPacketId(b)),
        }
    }
}

impl Packet {
    /// Creates an instance.
    pub const fn new(
        packet_type: PacketId,
        nsp: String,
        data: Option<String>,
        id: Option<i32>,
        attachment_count: u8,
        attachments: Option<Vec<Bytes>>,
    ) -> Self {
        Packet {
            packet_type,
            nsp,
            data,
            id,
            attachment_count,
            attachments,
        }
    }
}

impl From<Packet> for Bytes {
    fn from(packet: Packet) -> Self {
        Bytes::from(&packet)
    }
}

impl From<&Packet> for Bytes {
    /// Method for encoding from a `Packet` to a `u8` byte stream.
    /// The binary payload of a packet is not put at the end of the
    /// stream as it gets handled and send by it's own logic via the socket.
    fn from(packet: &Packet) -> Bytes {
        // first the packet type
        let mut buffer = String::new();
        buffer.push((packet.packet_type as u8 + b'0') as char);

        // eventually a number of attachments, followed by '-'
        if let PacketId::BinaryAck | PacketId::BinaryEvent = packet.packet_type {
            let _ = write!(buffer, "{}-", packet.attachment_count);
        }

        // if the namespace is different from the default one append it as well,
        // followed by ','
        if packet.nsp != "/" {
            buffer.push_str(&packet.nsp);
            buffer.push(',');
        }

        // if an id is present append it...
        if let Some(id) = packet.id {
            let _ = write!(buffer, "{id}");
        }

        if packet.attachments.is_some() {
            let num = packet.attachment_count - 1;

            // check if an event type is present
            if let Some(event_type) = packet.data.as_ref() {
                let _ = write!(
                    buffer,
                    "[{event_type},{{\"_placeholder\":true,\"num\":{num}}}]",
                );
            } else {
                let _ = write!(buffer, "[{{\"_placeholder\":true,\"num\":{num}}}]");
            }
        } else if let Some(data) = packet.data.as_ref() {
            buffer.push_str(data);
        }

        Bytes::from(buffer)
    }
}

impl TryFrom<Bytes> for Packet {
    type Error = Error;
    fn try_from(value: Bytes) -> Result<Self> {
        Packet::try_from(&value)
    }
}

impl TryFrom<&Bytes> for Packet {
    type Error = Error;
    /// Decodes a packet given a `Bytes` type.
    /// The binary payload of a packet is not put at the end of the
    /// stream as it gets handled and send by it's own logic via the socket.
    /// Therefore this method does not return the correct value for the
    /// binary data, instead the socket is responsible for handling
    /// this member. This is done because the attachment is usually
    /// send in another packet.
    fn try_from(payload: &Bytes) -> Result<Packet> {
        let mut payload = str_from_utf8(payload).map_err(Error::InvalidUtf8)?;
        let mut packet = Packet::default();

        // packet_type
        let id_char = payload.chars().next().ok_or(Error::IncompletePacket())?;
        packet.packet_type = PacketId::try_from(id_char)?;
        payload = &payload[id_char.len_utf8()..];

        // attachment_count
        if let PacketId::BinaryAck | PacketId::BinaryEvent = packet.packet_type {
            let (prefix, rest) = payload.split_once('-').ok_or(Error::IncompletePacket())?;
            payload = rest;
            packet.attachment_count = prefix.parse().map_err(|_| Error::InvalidPacket())?;
        }

        // namespace
        if payload.starts_with('/') {
            let (prefix, rest) = payload.split_once(',').ok_or(Error::IncompletePacket())?;
            payload = rest;
            packet.nsp.clear(); // clearing the default
            packet.nsp.push_str(prefix);
        }

        // id
        let Some((non_digit_idx, _)) = payload.char_indices().find(|(_, c)| !c.is_ascii_digit())
        else {
            return Ok(packet);
        };

        if non_digit_idx > 0 {
            let (prefix, rest) = payload.split_at(non_digit_idx);
            payload = rest;
            packet.id = Some(prefix.parse().map_err(|_| Error::InvalidPacket())?);
        }

        // validate json
        serde_json::from_str::<IgnoredAny>(payload).map_err(Error::InvalidJson)?;

        match packet.packet_type {
            PacketId::BinaryAck | PacketId::BinaryEvent => {
                if payload.starts_with('[') && payload.ends_with(']') {
                    payload = &payload[1..payload.len() - 1];
                }

                let mut str = payload.replace("{\"_placeholder\":true,\"num\":0}", "");

                if str.ends_with(',') {
                    str.pop();
                }

                if !str.is_empty() {
                    packet.data = Some(str);
                }
            }
            _ => packet.data = Some(payload.to_string()),
        }

        Ok(packet)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    /// This test suite is taken from the explanation section here:
    /// https://github.com/socketio/socket.io-protocol
    fn test_decode() {
        let payload = Bytes::from_static(b"0{\"token\":\"123\"}");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::Connect,
                "/".to_owned(),
                Some(String::from("{\"token\":\"123\"}")),
                None,
                0,
                None,
            ),
            packet.unwrap()
        );

        let utf8_data = "{\"token™\":\"123\"}".to_owned();
        let utf8_payload = format!("0/admin™,{}", utf8_data);
        let payload = Bytes::from(utf8_payload);
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::Connect,
                "/admin™".to_owned(),
                Some(utf8_data),
                None,
                0,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(b"1/admin,");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::Disconnect,
                "/admin".to_owned(),
                None,
                None,
                0,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(b"2[\"hello\",1]");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::Event,
                "/".to_owned(),
                Some(String::from("[\"hello\",1]")),
                None,
                0,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(b"2/admin,456[\"project:delete\",123]");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::Event,
                "/admin".to_owned(),
                Some(String::from("[\"project:delete\",123]")),
                Some(456),
                0,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(b"3/admin,456[]");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::Ack,
                "/admin".to_owned(),
                Some(String::from("[]")),
                Some(456),
                0,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(b"4/admin,{\"message\":\"Not authorized\"}");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::ConnectError,
                "/admin".to_owned(),
                Some(String::from("{\"message\":\"Not authorized\"}")),
                None,
                0,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(b"51-[\"hello\",{\"_placeholder\":true,\"num\":0}]");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::BinaryEvent,
                "/".to_owned(),
                Some(String::from("\"hello\"")),
                None,
                1,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(
            b"51-/admin,456[\"project:delete\",{\"_placeholder\":true,\"num\":0}]",
        );
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::BinaryEvent,
                "/admin".to_owned(),
                Some(String::from("\"project:delete\"")),
                Some(456),
                1,
                None,
            ),
            packet.unwrap()
        );

        let payload = Bytes::from_static(b"61-/admin,456[{\"_placeholder\":true,\"num\":0}]");
        let packet = Packet::try_from(&payload);
        assert!(packet.is_ok());

        assert_eq!(
            Packet::new(
                PacketId::BinaryAck,
                "/admin".to_owned(),
                None,
                Some(456),
                1,
                None,
            ),
            packet.unwrap()
        );
    }

    #[test]
    /// This test suites is taken from the explanation section here:
    /// https://github.com/socketio/socket.io-protocol
    fn test_encode() {
        let packet = Packet::new(
            PacketId::Connect,
            "/".to_owned(),
            Some(String::from("{\"token\":\"123\"}")),
            None,
            0,
            None,
        );

        assert_eq!(
            Bytes::from(&packet),
            "0{\"token\":\"123\"}".to_string().into_bytes()
        );

        let packet = Packet::new(
            PacketId::Connect,
            "/admin".to_owned(),
            Some(String::from("{\"token\":\"123\"}")),
            None,
            0,
            None,
        );

        assert_eq!(
            Bytes::from(&packet),
            "0/admin,{\"token\":\"123\"}".to_string().into_bytes()
        );

        let packet = Packet::new(
            PacketId::Disconnect,
            "/admin".to_owned(),
            None,
            None,
            0,
            None,
        );

        assert_eq!(Bytes::from(&packet), "1/admin,".to_string().into_bytes());

        let packet = Packet::new(
            PacketId::Event,
            "/".to_owned(),
            Some(String::from("[\"hello\",1]")),
            None,
            0,
            None,
        );

        assert_eq!(
            Bytes::from(&packet),
            "2[\"hello\",1]".to_string().into_bytes()
        );

        let packet = Packet::new(
            PacketId::Event,
            "/admin".to_owned(),
            Some(String::from("[\"project:delete\",123]")),
            Some(456),
            0,
            None,
        );

        assert_eq!(
            Bytes::from(&packet),
            "2/admin,456[\"project:delete\",123]"
                .to_string()
                .into_bytes()
        );

        let packet = Packet::new(
            PacketId::Ack,
            "/admin".to_owned(),
            Some(String::from("[]")),
            Some(456),
            0,
            None,
        );

        assert_eq!(
            Bytes::from(&packet),
            "3/admin,456[]".to_string().into_bytes()
        );

        let packet = Packet::new(
            PacketId::ConnectError,
            "/admin".to_owned(),
            Some(String::from("{\"message\":\"Not authorized\"}")),
            None,
            0,
            None,
        );

        assert_eq!(
            Bytes::from(&packet),
            "4/admin,{\"message\":\"Not authorized\"}"
                .to_string()
                .into_bytes()
        );

        let packet = Packet::new(
            PacketId::BinaryEvent,
            "/".to_owned(),
            Some(String::from("\"hello\"")),
            None,
            1,
            Some(vec![Bytes::from_static(&[1, 2, 3])]),
        );

        assert_eq!(
            Bytes::from(&packet),
            "51-[\"hello\",{\"_placeholder\":true,\"num\":0}]"
                .to_string()
                .into_bytes()
        );

        let packet = Packet::new(
            PacketId::BinaryEvent,
            "/admin".to_owned(),
            Some(String::from("\"project:delete\"")),
            Some(456),
            1,
            Some(vec![Bytes::from_static(&[1, 2, 3])]),
        );

        assert_eq!(
            Bytes::from(&packet),
            "51-/admin,456[\"project:delete\",{\"_placeholder\":true,\"num\":0}]"
                .to_string()
                .into_bytes()
        );

        let packet = Packet::new(
            PacketId::BinaryAck,
            "/admin".to_owned(),
            None,
            Some(456),
            1,
            Some(vec![Bytes::from_static(&[3, 2, 1])]),
        );

        assert_eq!(
            Bytes::from(&packet),
            "61-/admin,456[{\"_placeholder\":true,\"num\":0}]"
                .to_string()
                .into_bytes()
        );
    }

    #[test]
    fn test_illegal_packet_id() {
        let _sut = PacketId::try_from(42).expect_err("error!");
        assert!(matches!(Error::InvalidPacketId(42 as char), _sut))
    }

    #[test]
    fn new_from_payload_binary() {
        let payload = Payload::Binary(Bytes::from_static(&[0, 4, 9]), None);
        let result =
            Packet::new_from_payload(payload.clone(), "test_event".into(), "namespace", None)
                .unwrap();
        assert_eq!(
            result,
            Packet {
                packet_type: PacketId::BinaryEvent,
                nsp: "namespace".to_owned(),
                data: Some("\"test_event\"".to_owned()),
                id: None,
                attachment_count: 1,
                attachments: Some(vec![Bytes::from_static(&[0, 4, 9])])
            }
        )
    }

    #[test]
    #[allow(deprecated)]
    fn new_from_payload_string() {
        let payload = Payload::String("test".to_owned(), None);
        let result = Packet::new_from_payload(
            payload.clone(),
            "other_event".into(),
            "other_namespace",
            Some(10),
        )
        .unwrap();
        assert_eq!(
            result,
            Packet {
                packet_type: PacketId::Event,
                nsp: "other_namespace".to_owned(),
                data: Some("[\"other_event\",\"test\"]".to_owned()),
                id: Some(10),
                attachment_count: 0,
                attachments: None
            }
        )
    }

    #[test]
    fn new_from_payload_json() {
        let payload = Payload::Text(
            vec![
                serde_json::json!("String test"),
                serde_json::json!({"type":"object"}),
            ],
            None,
        );
        let result =
            Packet::new_from_payload(payload.clone(), "third_event".into(), "/", Some(10)).unwrap();
        assert_eq!(
            result,
            Packet {
                packet_type: PacketId::Event,
                nsp: "/".to_owned(),
                data: Some("[\"third_event\",\"String test\",{\"type\":\"object\"}]".to_owned()),
                id: Some(10),
                attachment_count: 0,
                attachments: None
            }
        )
    }

    #[test]
    fn ack_from_payload_binary() {
        let payload = Payload::Binary(Bytes::from_static(&[0, 4, 9]), None);
        let result = Packet::ack_from_payload(payload.clone(), "namespace", None).unwrap();
        assert_eq!(
            result,
            Packet {
                packet_type: PacketId::BinaryAck,
                nsp: "namespace".to_owned(),
                data: None,
                id: None,
                attachment_count: 1,
                attachments: Some(vec![Bytes::from_static(&[0, 4, 9])]),
            }
        )
    }

    #[test]
    #[allow(deprecated)]
    fn ack_from_payload_string() {
        let payload = Payload::String("test".to_owned(), None);
        let result =
            Packet::ack_from_payload(payload.clone(), "other_namespace", Some(10)).unwrap();
        assert_eq!(
            result,
            Packet {
                packet_type: PacketId::Ack,
                nsp: "other_namespace".to_owned(),
                data: Some("[\"test\"]".to_owned()),
                id: Some(10),
                attachment_count: 0,
                attachments: None,
            }
        )
    }

    #[test]
    fn ack_from_payload_json() {
        let payload = Payload::Text(
            vec![
                serde_json::json!("String test"),
                serde_json::json!({"type":"object"}),
            ],
            None,
        );
        let result = Packet::ack_from_payload(payload.clone(), "/", Some(10)).unwrap();
        assert_eq!(
            result,
            Packet {
                packet_type: PacketId::Ack,
                nsp: "/".to_owned(),
                data: Some("[\"String test\",{\"type\":\"object\"}]".to_owned()),
                id: Some(10),
                attachment_count: 0,
                attachments: None,
            }
        )
    }
}
