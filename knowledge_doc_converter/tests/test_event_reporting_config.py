from knowledge_doc_converter.config import ConverterSettings


def test_invalid_optional_kafka_config_does_not_break_converter():
    settings = ConverterSettings(
        _env_file=None,
        EVENT_REPORTING_ENABLED=False,
        EVENT_KAFKA_REQUEST_TIMEOUT_MS="invalid",
    )
    assert settings.event_reporter_config("converter").validation_error() == (
        "invalid_event_configuration"
    )


def test_event_reporter_config_uses_converter_dotenv(monkeypatch, tmp_path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "EVENT_REPORTING_ENABLED=true\n"
        "EVENT_KAFKA_BOOTSTRAP_SERVERS=kafka:9092\n"
        "EVENT_KAFKA_ENVIRONMENT=dev\n"
        "EVENT_KAFKA_SECURITY_PROTOCOL=SASL_PLAINTEXT\n"
        "EVENT_KAFKA_SASL_USERNAME=user\n"
        "EVENT_KAFKA_SASL_PASSWORD=password\n",
        encoding="utf-8",
    )
    for name in (
        "EVENT_REPORTING_ENABLED",
        "EVENT_KAFKA_BOOTSTRAP_SERVERS",
        "EVENT_KAFKA_ENVIRONMENT",
        "EVENT_KAFKA_SECURITY_PROTOCOL",
        "EVENT_KAFKA_SASL_USERNAME",
        "EVENT_KAFKA_SASL_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = ConverterSettings(_env_file=env_file)
    config = settings.event_reporter_config("knowledge_doc_converter")

    assert config.enabled is True
    assert config.bootstrap_servers == "kafka:9092"
    assert config.environment == "dev"
    assert config.sasl_password == "password"
    assert config.client_id == "knowledge_doc_converter-event-reporter"
    assert config.validation_error() is None
