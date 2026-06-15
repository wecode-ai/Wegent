from app.services.web_scraper.markdown.html_to_markdown import HtmlToMarkdownConverter


def test_html_to_markdown_preserves_headings_links_lists_and_tables() -> None:
    html = """
    <h1>Guide</h1>
    <p>Read the <a href="/docs">docs</a>.</p>
    <ul><li>One</li><li>Two</li></ul>
    <table><tr><th>Name</th></tr><tr><td>Wegent</td></tr></table>
    """

    markdown = HtmlToMarkdownConverter().to_markdown(
        html, base_url="https://example.com"
    )

    assert "# Guide" in markdown
    assert "[docs](https://example.com/docs)" in markdown
    assert "One" in markdown
    assert "Two" in markdown
    assert "Wegent" in markdown
