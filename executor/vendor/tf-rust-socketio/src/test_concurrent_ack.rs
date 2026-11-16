#[cfg(test)]
mod test_concurrent_ack {
    use crate::payload::Payload;

    #[test]
    fn test_payload_ack_id_concurrency() {
        // Test that multiple payloads can have different ack_ids
        let payload1 = Payload::Text(vec![serde_json::json!("message1")], Some(1));
        let payload2 = Payload::Text(vec![serde_json::json!("message2")], Some(2));
        let payload3 = Payload::Binary(vec![1, 2, 3].into(), Some(3));

        assert_eq!(payload1.ack_id(), Some(1));
        assert_eq!(payload2.ack_id(), Some(2));
        assert_eq!(payload3.ack_id(), Some(3));

        // Test setting ack_id
        let mut payload = Payload::Text(vec![serde_json::json!("test")], None);
        assert_eq!(payload.ack_id(), None);

        payload.set_ack_id(Some(42));
        assert_eq!(payload.ack_id(), Some(42));

        // Test with_ack_id method
        let base_payload = Payload::Text(vec![serde_json::json!("base")], None);
        let with_ack = Payload::with_ack_id(base_payload, 100);
        assert_eq!(with_ack.ack_id(), Some(100));
    }

    #[test]
    fn test_concurrent_ack_scenario() {
        // Simulate a scenario where multiple messages with different ack_ids are received
        let messages = vec![
            Payload::Text(vec![serde_json::json!("msg1")], Some(10)),
            Payload::Text(vec![serde_json::json!("msg2")], Some(11)),
            Payload::Binary(vec![4, 5, 6].into(), Some(12)),
        ];

        // Each message should maintain its own ack_id
        for (i, msg) in messages.iter().enumerate() {
            assert_eq!(msg.ack_id(), Some(10 + i as i32));
        }

        // Verify that ack_ids don't interfere with each other
        let msg1 = messages[0].clone();
        let msg2 = messages[1].clone();

        // Modifying one shouldn't affect the other
        let mut modified_msg1 = msg1;
        modified_msg1.set_ack_id(Some(999));

        assert_eq!(modified_msg1.ack_id(), Some(999));
        assert_eq!(msg2.ack_id(), Some(11));
    }
}
