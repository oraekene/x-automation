import unittest

from n8ncorpus import docs


class FrontmatterTest(unittest.TestCase):
    def test_extracts_title_and_description(self):
        text = """---
title: My Page
description: Does a thing
---
# Heading
"""
        fm = docs.extract_frontmatter(text)
        self.assertEqual(fm, {"title": "My Page", "description": "Does a thing"})

    def test_handles_quoted_values(self):
        text = '---\ntitle: "Quoted"\ndescription: \'single\'\n---\n'
        fm = docs.extract_frontmatter(text)
        self.assertEqual(fm, {"title": "Quoted", "description": "single"})

    def test_no_frontmatter(self):
        self.assertEqual(docs.extract_frontmatter("# No fm\n"), {})

    def test_ignores_other_keys(self):
        text = "---\ntitle: T\nsidebar_position: 3\n---\n"
        self.assertEqual(docs.extract_frontmatter(text), {"title": "T"})


class DocTitleTest(unittest.TestCase):
    def test_frontmatter_wins(self):
        text = "---\ntitle: From FM\n---\n# From Heading\n"
        self.assertEqual(docs.doc_title(text, "page.md"), "From FM")

    def test_heading_fallback(self):
        self.assertEqual(docs.doc_title("# Big Heading\nbody", "page.md"), "Big Heading")

    def test_filename_fallback(self):
        self.assertEqual(docs.doc_title("no heading here", "dir/my-page.md"), "my-page")


class DocDescriptionTest(unittest.TestCase):
    def test_frontmatter_wins(self):
        text = "---\ndescription: From FM\n---\n# H\nfirst paragraph"
        self.assertEqual(docs.doc_description(text), "From FM")

    def test_first_paragraph_fallback(self):
        text = "# H\n\nThis is the first real line.\nMore lines.\n"
        self.assertEqual(docs.doc_description(text), "This is the first real line.")

    def test_skips_headings_lists_and_code(self):
        text = "# H\n- item\n```\ncode\n```\n> quote\nActual text here.\n"
        self.assertEqual(docs.doc_description(text), "Actual text here.")


class DocEntriesTest(unittest.TestCase):
    def test_collects_every_markdown_file(self):
        entries = docs.doc_entries(
            [
                ("README.md", "# Fixture\nA one-liner.\n"),
                ("docs/page.md", "---\ntitle: Page\n---\nbody\n"),
                ("scripts/thing.py", "# not markdown\n"),
            ]
        )
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0], {"path": "README.md", "title": "Fixture", "description": "A one-liner."})
        self.assertEqual(
            entries[1], {"path": "docs/page.md", "title": "Page", "description": "body"}
        )


class ParseLlmsTest(unittest.TestCase):
    CONTENTS = """# Index

## Guides

- [Getting Started](getting-started.md): start here
- [Templates](templates/): browse the templates
- [External](https://example.com/x.md)

## Notes

- [Config](config.json)
"""

    def test_parses_llmstxt_entries(self):
        entries = docs.parse_llms(self.CONTENTS)
        self.assertEqual(
            entries,
            [
                {"path": "getting-started.md", "title": "Getting Started", "description": "start here"},
                {"path": "templates/", "title": "Templates", "description": "browse the templates"},
                {"path": "config.json", "title": "Config", "description": ""},
            ],
        )

    def test_skips_external_urls(self):
        paths = [e["path"] for e in docs.parse_llms(self.CONTENTS)]
        self.assertNotIn("https://example.com/x.md", paths)

    def test_strips_dot_slash_prefix(self):
        entries = docs.parse_llms("- [X](./docs/a.md)")
        self.assertEqual(entries[0]["path"], "docs/a.md")


class RepoTopTest(unittest.TestCase):
    def test_readme_one_liner(self):
        self.assertEqual(docs.readme_one_liner("# Welcome\n\nThe corpus."), "Welcome")

    def test_readme_one_liner_no_heading(self):
        self.assertEqual(docs.readme_one_liner("Just a line.\n"), "Just a line.")

    def test_readme_one_liner_blank(self):
        self.assertEqual(docs.readme_one_liner(""), "")

    def test_repo_top_entries(self):
        entries = docs.repo_top_entries(
            "fixture-repo",
            [
                ("guides", "# Guides\nLong text."),
                ("templates", ""),
            ],
        )
        self.assertEqual(
            entries,
            [
                {"repo": "fixture-repo", "path": "guides", "description": "Guides"},
                {"repo": "fixture-repo", "path": "templates", "description": "templates"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
