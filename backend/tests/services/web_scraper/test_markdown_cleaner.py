from app.services.web_scraper.markdown.cleaner import MarkdownCleaner
from app.services.web_scraper.policy import ScrapePolicy


def test_cleaner_removes_nav_footer_buttons() -> None:
    html = """
    <nav>Home Pricing</nav>
    <main><h1>Real Content</h1><p>This paragraph should stay.</p></main>
    <button>Share</button>
    <footer>Copyright</footer>
    """

    cleaned = MarkdownCleaner().clean_html(html, ScrapePolicy())

    assert "Home Pricing" not in cleaned
    assert "Share" not in cleaned
    assert "Copyright" not in cleaned
    assert "This paragraph should stay." in cleaned


def test_cleaner_keeps_body_text_with_action_words() -> None:
    html = """
    <article>
      <h1>操作说明</h1>
      <p>点击登录按钮后，表单会显示在页面右侧。</p>
    </article>
    """

    cleaned = MarkdownCleaner().clean_html(html, ScrapePolicy())

    assert "点击登录按钮后" in cleaned
    assert "表单会显示" in cleaned


def test_cleaner_deduplicates_repeated_blocks() -> None:
    markdown = "\n".join(["repeat this navigation"] * 5 + ["unique body paragraph"])

    cleaned = MarkdownCleaner().clean_markdown(markdown, ScrapePolicy())

    assert cleaned.count("repeat this navigation") == 2
    assert "unique body paragraph" in cleaned


def test_plain_text_cleaner_preserves_crlf_line_continuation() -> None:
    text = "first line\r\nsecond line"

    cleaned = MarkdownCleaner().clean_plain_text(text, ScrapePolicy())

    assert cleaned == "first line second line"
