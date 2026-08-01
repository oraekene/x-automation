import unittest

from n8ncorpus import links

LINKS_TEXT = """# Awesome n8n

- [Slack Notify](https://n8n.io/workflows/123-slack-notify/)
- [Raw Flow](https://example.com/raw/flow.json)
- [Blog](https://blog.example.com/post)

More: https://n8n.io/workflows/456-other/ and https://example.com/raw/flow.json
"""


class ParseLinkListTest(unittest.TestCase):
    def test_extracts_markdown_and_bare_links(self):
        urls = links.parse_link_list(LINKS_TEXT)
        self.assertEqual(
            urls,
            [
                "https://n8n.io/workflows/123-slack-notify/",
                "https://example.com/raw/flow.json",
                "https://blog.example.com/post",
                "https://n8n.io/workflows/456-other/",
            ],
        )

    def test_dedupes_links(self):
        urls = links.parse_link_list("[A](https://x.io/a/) [B](https://x.io/a/)")
        self.assertEqual(urls, ["https://x.io/a/"])

    def test_strips_trailing_punctuation(self):
        urls = links.parse_link_list("[A](https://x.io/a/). See [B](https://x.io/b/).")
        self.assertEqual(urls, ["https://x.io/a/", "https://x.io/b/"])

    def test_relative_links_ignored(self):
        self.assertEqual(links.parse_link_list("[A](../other.md)"), [])


class ClassifyTest(unittest.TestCase):
    def test_workflow_page_is_workflow_link(self):
        self.assertTrue(links.is_workflow_link("https://n8n.io/workflows/123-slug/"))

    def test_workflow_page_without_slug_is_workflow_link(self):
        self.assertTrue(links.is_workflow_link("https://n8n.io/workflows/123/"))

    def test_raw_json_is_workflow_link(self):
        self.assertTrue(links.is_workflow_link("https://example.com/raw/flow.json"))

    def test_blog_is_not_workflow_link(self):
        self.assertFalse(links.is_workflow_link("https://blog.example.com/post"))

    def test_external_docs_are_not_workflow_links(self):
        self.assertFalse(links.is_workflow_link("https://docs.example.com/guide"))
        self.assertFalse(links.is_workflow_link("https://github.com/some/repo"))

    def test_homepage_is_not_workflow_link(self):
        self.assertFalse(links.is_workflow_link("https://n8n.io/"))


class ExtractIdTest(unittest.TestCase):
    def test_extracts_id_from_slug_url(self):
        self.assertEqual(links.extract_n8n_id("https://n8n.io/workflows/123-slack-notify/"), "123")

    def test_extracts_id_without_slug(self):
        self.assertEqual(links.extract_n8n_id("https://n8n.io/workflows/456/"), "456")

    def test_none_for_non_workflow_pages(self):
        self.assertIsNone(links.extract_n8n_id("https://n8n.io/"))
        self.assertIsNone(links.extract_n8n_id("https://example.com/raw/flow.json"))


class PageWorkflowTest(unittest.TestCase):
    def test_extracts_workflow_from_json_script(self):
        html = '<html><script type="application/json">{"name": "W", "nodes": [], "connections": {}}</script></html>'
        self.assertEqual(
            links.extract_page_workflow(html),
            '{"name": "W", "nodes": [], "connections": {}}',
        )

    def test_ignores_non_workflow_json_scripts(self):
        html = '<script type="application/json">{"foo": 1}</script>'
        self.assertIsNone(links.extract_page_workflow(html))

    def test_none_when_no_script(self):
        self.assertIsNone(links.extract_page_workflow("<html><body>nothing</body></html>"))


class HtmlToTextTest(unittest.TestCase):
    def test_strips_tags_and_collapses_whitespace(self):
        html = "<html><body><h1>Title</h1><p>Some   text.</p><p>More.</p></body></html>"
        self.assertEqual(links.html_to_text(html), "Title Some text. More.")

    def test_skips_script_contents(self):
        html = '<p>Guide text.</p><script type="application/json">{"name": "W"}</script>'
        self.assertEqual(links.html_to_text(html), "Guide text.")


if __name__ == "__main__":
    unittest.main()
