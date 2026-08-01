import json
import tempfile
import unittest
from pathlib import Path

from tests.helpers import commit_more, head_sha, make_fixture_repo

from n8ncorpus import crawler


class FirstCrawlTest(unittest.TestCase):
    def test_crawl_mirrors_repo_and_records_pin(self):
        repo = make_fixture_repo(
            {"README.md": "# Fixture\n", "notes/hello.txt": "hi\n"}
        )
        sha = head_sha(repo)
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        crawler.crawl(corpus, configs)

        mirror = corpus / "repos" / "fixture-repo"
        self.assertTrue((mirror / "README.md").exists())
        self.assertTrue((mirror / "notes" / "hello.txt").exists())
        self.assertFalse((mirror / ".git").exists())

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], 1)
        self.assertEqual(manifest["repos"]["fixture-repo"]["url"], str(repo))
        self.assertEqual(manifest["repos"]["fixture-repo"]["pin"]["sha"], sha)
        self.assertIn("crawled_at", manifest["repos"]["fixture-repo"]["pin"])
        self.assertIn("crawled_at", manifest)
        self.assertEqual(manifest["workflows"], [])
        self.assertEqual(
            manifest["docs"],
            [{"repo": "fixture-repo", "path": "README.md", "title": "Fixture", "description": ""}],
        )
        self.assertEqual(manifest["followed"], [])

    def test_crawl_indexes_workflows(self):
        repo = make_fixture_repo(
            {
                "flows/slack-notify.json": '{"name": "Slack Notify", "nodes": [{"name": "Trigger"}, {"name": "Slack"}], "connections": {"Trigger": []}, "description": "posts to slack"}',
                "data/config.json": '{"version": 2}',
                "README.md": "# Fixture\n",
            }
        )
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["workflows"]), 1)
        workflow = manifest["workflows"][0]
        self.assertEqual(workflow["repo"], "fixture-repo")
        self.assertEqual(workflow["path"], "flows/slack-notify.json")
        self.assertEqual(workflow["name"], "Slack Notify")
        self.assertEqual(workflow["description"], "posts to slack")
        self.assertEqual(workflow["node_count"], 2)
        self.assertIn("hash", workflow)

    def test_crawl_indexes_docs_and_top_level_dirs(self):
        repo = make_fixture_repo(
            {
                "README.md": "# Fixture\nA one-liner.\n",
                "docs/page.md": "---\ntitle: Page\ndescription: Does a thing\n---\nbody\n",
                "guides/README.md": "# Guides\nLong guide text.\n",
                "templates/placeholder.txt": "x",
            }
        )
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["docs"],
            [
                {"repo": "fixture-repo", "path": "README.md", "title": "Fixture", "description": "A one-liner."},
                {"repo": "fixture-repo", "path": "docs/page.md", "title": "Page", "description": "Does a thing"},
                {"repo": "fixture-repo", "path": "guides/README.md", "title": "Guides", "description": "Long guide text."},
            ],
        )
        self.assertEqual(
            manifest["repo_top"],
            [
                {"repo": "fixture-repo", "path": "docs", "description": "docs"},
                {"repo": "fixture-repo", "path": "guides", "description": "Guides"},
                {"repo": "fixture-repo", "path": "templates", "description": "templates"},
            ],
        )

    def test_crawl_uses_llms_txt_as_docs_index(self):
        repo = make_fixture_repo(
            {
                "llms.txt": "# Index\n\n## Files\n\n- [Setup](setup.md): how to set up\n- [External](https://example.com/x.md)\n",
                "setup.md": "---\ntitle: Setup\n---\nbody\n",
                "README.md": "# Fixture\n",
            }
        )
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["docs"],
            [
                {"repo": "fixture-repo", "path": "setup.md", "title": "Setup", "description": "how to set up"},
                {"repo": "fixture-repo", "path": "README.md", "title": "Fixture", "description": ""},
            ],
        )

    def test_unreachable_repo_is_flagged_and_crawl_continues(self):
        repo = make_fixture_repo({"README.md": "# Fixture\n"})
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [
            {"key": "unreachable", "url": str(corpus / "does-not-exist")},
            {"key": "fixture-repo", "url": str(repo)},
        ]

        crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertNotIn("unreachable", manifest["repos"])
        self.assertEqual(
            manifest["flags"], [{"repo": "unreachable", "message": "unreachable repo"}]
        )
        self.assertTrue((corpus / "repos" / "fixture-repo" / "README.md").exists())


class RecrawlTest(unittest.TestCase):
    def test_unchanged_repo_is_skipped_but_reindexed(self):
        repo = make_fixture_repo(
            {"README.md": "# Fixture\n", "flows/a.json": '{"name": "A", "nodes": [], "connections": {}}'}
        )
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        first = crawler.crawl(corpus, configs)
        mirror = corpus / "repos" / "fixture-repo"
        (mirror / "stray.txt").write_text("survivor", encoding="utf-8")
        second = crawler.crawl(corpus, configs)

        self.assertFalse(first["repos"]["fixture-repo"]["skipped"])
        self.assertTrue(second["repos"]["fixture-repo"]["skipped"])
        self.assertEqual(
            second["repos"]["fixture-repo"]["pin"]["sha"],
            first["repos"]["fixture-repo"]["pin"]["sha"],
        )
        self.assertEqual(
            second["repos"]["fixture-repo"]["pin"]["crawled_at"],
            first["repos"]["fixture-repo"]["pin"]["crawled_at"],
        )
        self.assertTrue((mirror / "stray.txt").exists(), "skip path must not re-clone")
        self.assertEqual(len(second["workflows"]), 1)
        self.assertEqual(second["workflows"][0]["path"], "flows/a.json")
        self.assertEqual(second["workflows"][0]["name"], "A")

    def test_changed_repo_reclones_and_repins(self):
        repo = make_fixture_repo({"README.md": "# Fixture\n"})
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        crawler.crawl(corpus, configs)
        mirror = corpus / "repos" / "fixture-repo"
        (mirror / "stray.txt").write_text("doomed", encoding="utf-8")
        new_sha = commit_more(repo, {"flows/b.json": '{"name": "B", "nodes": [], "connections": {}}'})
        second = crawler.crawl(corpus, configs)

        self.assertFalse(second["repos"]["fixture-repo"]["skipped"])
        self.assertEqual(second["repos"]["fixture-repo"]["pin"]["sha"], new_sha)
        self.assertFalse((mirror / "stray.txt").exists(), "changed repo must re-clone")
        self.assertEqual(second["workflows"][0]["path"], "flows/b.json")

    def test_force_reclones_unchanged_repo(self):
        repo = make_fixture_repo({"README.md": "# Fixture\n"})
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        crawler.crawl(corpus, configs)
        mirror = corpus / "repos" / "fixture-repo"
        (mirror / "stray.txt").write_text("doomed", encoding="utf-8")
        second = crawler.crawl(corpus, configs, force=True)

        self.assertFalse(second["repos"]["fixture-repo"]["skipped"])
        self.assertFalse((mirror / "stray.txt").exists())


if __name__ == "__main__":
    unittest.main()
