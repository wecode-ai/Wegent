from app.services.web_scraper.profiles import BrowserProfileFactory


def test_profile_factory_returns_independent_profiles() -> None:
    factory = BrowserProfileFactory()

    first = factory.create("desktop_chrome_cn")
    first.viewport["width"] = 1
    first.headers["Accept-Language"] = "mutated"

    second = factory.create("desktop_chrome_cn")

    assert second.viewport["width"] == 1366
    assert second.headers["Accept-Language"] == "zh-CN,zh;q=0.9,en;q=0.8"
