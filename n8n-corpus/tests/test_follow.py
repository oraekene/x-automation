import json
import tempfile
import unittest
from pathlib import Path

from tests.helpers import FixtureHttpServer, make_fixture_repo

from n8ncorpus import crawler, dedupe

WORKFLOW_JSON = '{"name": "From Site", "nodes": [{"name": "Trigger"}], "connections": {}}'
RAW_JSON = '{"name": "Raw Flow", "nodes": [], "connections": {}}'
PAGE_HTML = (
    "<html><body>"
    "<h1>Slack Notify</h1>"
    "<p>Send a message when an issue opens.</p>"
    f'<script type="application/json">{WORKFLOW_JSON}</script>'
    '<a href="/workflows/999-second-hop/">never followed</a>'
    "</body></html>"
)


def page_html(workflow_json: str, heading: str = "Flow") -> str:
    return (
        "<html><body>"
        f"<h1>{heading}</h1>"
        f'<script type="application/json">{workflow_json}</script>'
        "</body></html>"
    )


class FollowLinksTest(unittest.TestCase):
    def test_follows_workflow_links_one_hop(self):
        with FixtureHttpServer(
            {
                "/workflows/123-slack-notify/": PAGE_HTML,
                "/raw/flow.json": RAW_JSON,
                "/blog/post": "<html><body><p>a blog post</p></body></html>",
            }
        ) as server:
            repo = make_fixture_repo(
                {
                    "README.md": (
                        "# Templates\n\n"
                        f"- [Slack Notify]({server.base}/workflows/123-slack-notify/)\n"
                        f"- [Raw]({server.base}/raw/flow.json)\n"
                        f"- [Blog]({server.base}/blog/post)\n"
                    )
                }
            )
            corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
            configs = [{"key": "fixture-repo", "url": str(repo)}]

            crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        followed = manifest["followed"]
        self.assertEqual(len(followed), 2)

        page = next(f for f in followed if f["n8n_id"] == "123")
        self.assertEqual(page["repo"], "fixture-repo")
        self.assertEqual(page["url"], f"{server.base}/workflows/123-slack-notify/")
        self.assertEqual(
            (corpus / page["workflow_path"]).read_text(encoding="utf-8"), WORKFLOW_JSON
        )
        guide = (corpus / page["guide_path"]).read_text(encoding="utf-8")
        self.assertIn("Send a message when an issue opens.", guide)
        self.assertNotIn(WORKFLOW_JSON, guide)
        self.assertEqual(page["dedupe"], {"status": "stored", "resolves_to": ""})

        raw = next(f for f in followed if not f["n8n_id"])
        self.assertEqual(raw["url"], f"{server.base}/raw/flow.json")
        self.assertEqual(raw["guide_path"], "")
        self.assertEqual(
            (corpus / raw["workflow_path"]).read_text(encoding="utf-8"), RAW_JSON
        )

        self.assertTrue(all("blog" not in f["url"] for f in followed))
        self.assertTrue(all("999" not in f["url"] for f in followed))
        self.assertFalse((corpus / "repos" / "fixture-repo" / "123.json").exists())

    def test_dedupe_mirror_wins_and_duplicates_alias(self):
        flow_b = '{"name": "B", "nodes": [], "connections": {}}'
        with FixtureHttpServer(
            {
                "/workflows/1-mirrored/": page_html(WORKFLOW_JSON, "Mirrored"),
                "/workflows/2-first/": page_html(flow_b, "First"),
                "/workflows/3-copy/": page_html(flow_b, "Copy"),
            }
        ) as server:
            repo = make_fixture_repo(
                {
                    "workflows/dup.json": WORKFLOW_JSON,
                    "README.md": (
                        "# Templates\n\n"
                        f"- [M]({server.base}/workflows/1-mirrored/)\n"
                        f"- [F]({server.base}/workflows/2-first/)\n"
                        f"- [C]({server.base}/workflows/3-copy/)\n"
                    ),
                }
            )
            corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
            configs = [{"key": "fixture-repo", "url": str(repo)}]

            crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        followed = {f["n8n_id"]: f for f in manifest["followed"]}
        self.assertEqual(len(followed), 3)

        mirror_resolved = followed["1"]
        self.assertEqual(
            mirror_resolved["dedupe"],
            {"status": "mirror", "resolves_to": "repos/fixture-repo/workflows/dup.json"},
        )
        self.assertEqual(mirror_resolved["workflow_path"], "")
        self.assertFalse((corpus / "fetched/fixture-repo/1.json").exists())
        self.assertTrue(
            (corpus / mirror_resolved["guide_path"]).exists(),
            "page guide text is unique and still captured",
        )

        stored = followed["2"]
        self.assertEqual(stored["dedupe"], {"status": "stored", "resolves_to": ""})
        self.assertTrue((corpus / stored["workflow_path"]).exists())

        aliased = followed["3"]
        self.assertEqual(
            aliased["dedupe"],
            {"status": "alias", "resolves_to": stored["workflow_path"]},
        )
        self.assertEqual(aliased["workflow_path"], "")
        self.assertFalse((corpus / "fetched/fixture-repo/3.json").exists())

    def test_unresolvable_links_become_flags(self):
        with FixtureHttpServer({}) as server:
            repo = make_fixture_repo(
                {
                    "README.md": (
                        f"- [Dead]({server.base}/workflows/999-dead/)\n"
                        f"- [Missing]({server.base}/raw/missing.json)\n"
                    )
                }
            )
            corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
            configs = [{"key": "fixture-repo", "url": str(repo)}]

            crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["followed"], [])
        self.assertEqual(
            sorted(f["message"] for f in manifest["flags"]),
            sorted(
                [
                    f"unresolvable workflow link: {server.base}/workflows/999-dead/",
                    f"unresolvable workflow link: {server.base}/raw/missing.json",
                ]
            ),
        )
        self.assertTrue(all(f["repo"] == "fixture-repo" for f in manifest["flags"]))

    def test_raw_non_workflow_json_is_flagged(self):
        with FixtureHttpServer({"/raw/config.json": '{"version": 2}'}) as server:
            repo = make_fixture_repo(
                {"README.md": f"- [Config]({server.base}/raw/config.json)\n"}
            )
            corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
            configs = [{"key": "fixture-repo", "url": str(repo)}]

            crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["followed"], [])
        self.assertEqual(
            manifest["flags"],
            [
                {
                    "repo": "fixture-repo",
                    "message": f"not a workflow: {server.base}/raw/config.json",
                }
            ],
        )

    def test_truncated_response_is_flagged_not_fatal(self):
        with FixtureHttpServer(
            {"/workflows/9-broken/": ("partial", PAGE_HTML)}
        ) as server:
            repo = make_fixture_repo(
                {"README.md": f"- [Broken]({server.base}/workflows/9-broken/)\n"}
            )
            corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
            configs = [{"key": "fixture-repo", "url": str(repo)}]

            crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["followed"], [])
        self.assertEqual(
            manifest["flags"],
            [
                {
                    "repo": "fixture-repo",
                    "message": f"unresolvable workflow link: {server.base}/workflows/9-broken/",
                }
            ],
        )

    def test_no_follow_skips_link_fetching(self):
        repo = make_fixture_repo(
            {"README.md": "- [Dead](https://n8n.io/workflows/999-dead/)\n"}
        )
        corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
        configs = [{"key": "fixture-repo", "url": str(repo)}]

        crawler.crawl(corpus, configs, follow=False)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["followed"], [])
        self.assertEqual(manifest["flags"], [])

    def test_skipped_repo_preserves_followed_without_refetch(self):
        with FixtureHttpServer(
            {"/workflows/1-page/": page_html(WORKFLOW_JSON, "Flow")}
        ) as server:
            repo = make_fixture_repo(
                {"README.md": f"- [Flow]({server.base}/workflows/1-page/)\n"}
            )
            corpus = Path(tempfile.mkdtemp(prefix="n8n-corpus-")) / "corpus"
            configs = [{"key": "fixture-repo", "url": str(repo)}]

            first = crawler.crawl(corpus, configs)
            server._server.RequestHandlerClass.routes = {}
            second = crawler.crawl(corpus, configs)

        manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(second["repos"]["fixture-repo"]["skipped"])
        self.assertEqual(len(manifest["followed"]), 1)
        self.assertEqual(manifest["followed"][0]["n8n_id"], "1")
        self.assertEqual(manifest["flags"], [], "skipped repo must not re-fetch")
        self.assertTrue((corpus / manifest["followed"][0]["workflow_path"]).exists())


if __name__ == "__main__":
    unittest.main()
