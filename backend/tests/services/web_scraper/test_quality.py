from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.quality import MarkdownQualityEvaluator


def test_quality_accepts_structured_markdown() -> None:
    markdown = "# Title\n\nThis is a useful body paragraph with enough content."

    quality = MarkdownQualityEvaluator().evaluate(markdown, ScrapePolicy())

    assert quality.acceptable is True
    assert quality.quality_level == "structured"
    assert quality.heading_count == 1


def test_quality_rejects_access_denied_page() -> None:
    markdown = "# Access Denied\n\nPlease complete captcha validation."

    quality = MarkdownQualityEvaluator().evaluate(markdown, ScrapePolicy())

    assert quality.acceptable is False
    assert quality.reason == "blocked_or_auth_shell"


def test_quality_marks_plain_text_as_degraded() -> None:
    markdown = "This plain text fallback contains enough useful content for indexing."

    quality = MarkdownQualityEvaluator().evaluate(
        markdown, ScrapePolicy(), quality_level="degraded"
    )

    assert quality.acceptable is True
    assert quality.quality_level == "degraded"
