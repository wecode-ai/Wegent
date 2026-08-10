from app.api.ws.events import GenerateParams


def test_generate_params_preserves_image_size():
    params = GenerateParams.model_validate({"size": "1512x648"})

    assert params.size == "1512x648"
    assert params.model_dump(exclude_none=True) == {"size": "1512x648"}
