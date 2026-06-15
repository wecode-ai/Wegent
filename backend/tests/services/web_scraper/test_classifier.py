from app.services.web_scraper.classifier import ScrapeResultClassifier
from app.services.web_scraper.models import (
    ERROR_AUTH_REQUIRED,
    ERROR_EMPTY_CONTENT,
    ERROR_FETCH_BLOCKED,
    ERROR_RATE_LIMITED,
    InternalScrapeResult,
    ScrapeStatus,
)
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.quality import MarkdownQualityEvaluator


def test_classifier_marks_good_markdown_ok() -> None:
    policy = ScrapePolicy()
    result = InternalScrapeResult(
        url="https://example.com",
        markdown="This is a sufficiently long markdown body for indexing content.",
    )
    quality = MarkdownQualityEvaluator().evaluate(result.markdown, policy)

    decision = ScrapeResultClassifier().classify(result, quality)

    assert decision.status == ScrapeStatus.OK


def test_classifier_detects_empty_content() -> None:
    result = InternalScrapeResult(url="https://example.com", markdown="")

    decision = ScrapeResultClassifier().classify(result)

    assert decision.status == ScrapeStatus.EMPTY
    assert decision.error_code == ERROR_EMPTY_CONTENT
    assert decision.should_try_fallback is True


def test_classifier_maps_status_codes() -> None:
    classifier = ScrapeResultClassifier()

    assert (
        classifier.classify(
            InternalScrapeResult(url="https://example.com", status_code=401)
        ).error_code
        == ERROR_AUTH_REQUIRED
    )
    assert (
        classifier.classify(
            InternalScrapeResult(url="https://example.com", status_code=403)
        ).error_code
        == ERROR_FETCH_BLOCKED
    )
    assert (
        classifier.classify(
            InternalScrapeResult(url="https://example.com", status_code=429)
        ).error_code
        == ERROR_RATE_LIMITED
    )


def test_low_quality_status_triggers_fallback() -> None:
    policy = ScrapePolicy()
    result = InternalScrapeResult(url="https://example.com", markdown="short")
    quality = MarkdownQualityEvaluator().evaluate(result.markdown, policy)
    classifier = ScrapeResultClassifier()

    decision = classifier.classify(result, quality)

    assert decision.status == ScrapeStatus.LOW_QUALITY
    assert classifier.should_use_playwright_fallback(decision, quality, policy)


def test_deep_iframe_fallback_skips_auth_and_rate_limit() -> None:
    policy = ScrapePolicy(deep_iframe_extraction=True)
    classifier = ScrapeResultClassifier()

    auth_decision = classifier.classify(
        InternalScrapeResult(url="https://example.com", status_code=401)
    )
    rate_limit_decision = classifier.classify(
        InternalScrapeResult(url="https://example.com", status_code=429)
    )

    assert auth_decision.status == ScrapeStatus.AUTH_REQUIRED
    assert rate_limit_decision.status == ScrapeStatus.RATE_LIMITED
    assert not classifier.should_use_playwright_fallback(auth_decision, None, policy)
    assert not classifier.should_use_playwright_fallback(
        rate_limit_decision, None, policy
    )


def test_deep_iframe_fallback_can_override_empty_fallback_flag() -> None:
    policy = ScrapePolicy(deep_iframe_extraction=True, fallback_on_empty=False)
    classifier = ScrapeResultClassifier()
    decision = classifier.classify(
        InternalScrapeResult(url="https://example.com", markdown="")
    )

    assert decision.status == ScrapeStatus.EMPTY
    assert classifier.should_use_playwright_fallback(decision, None, policy)


def test_fallback_enabled_disables_deep_iframe_fallback() -> None:
    policy = ScrapePolicy(
        deep_iframe_extraction=True,
        fallback_enabled=False,
    )
    classifier = ScrapeResultClassifier()
    decision = classifier.classify(
        InternalScrapeResult(url="https://example.com", markdown="")
    )

    assert decision.status == ScrapeStatus.EMPTY
    assert not classifier.should_use_playwright_fallback(decision, None, policy)
