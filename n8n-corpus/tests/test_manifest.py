import unittest

from n8ncorpus import manifest


class NewManifestTest(unittest.TestCase):
    def test_skeleton_shape(self):
        m = manifest.new_manifest("2026-01-01T00:00:00+00:00")
        self.assertEqual(m["schema"], 1)
        self.assertEqual(m["crawled_at"], "2026-01-01T00:00:00+00:00")
        self.assertEqual(m["repos"], {})
        self.assertEqual(m["workflows"], [])
        self.assertEqual(m["docs"], [])
        self.assertEqual(m["followed"], [])
        self.assertEqual(m["repo_top"], [])
        self.assertEqual(m["flags"], [])


class RecordPinTest(unittest.TestCase):
    def test_records_pin(self):
        m = manifest.new_manifest("now")
        manifest.record_pin(m, "key", "url", "abc123", "now")
        self.assertEqual(
            m["repos"]["key"],
            {"url": "url", "pin": {"sha": "abc123", "crawled_at": "now"}, "skipped": False},
        )

    def test_records_skipped_pin(self):
        m = manifest.new_manifest("now")
        manifest.record_pin(m, "key", "url", "abc123", "then", skipped=True)
        self.assertTrue(m["repos"]["key"]["skipped"])


class AddEntriesTest(unittest.TestCase):
    def test_add_workflow_attributes_repo(self):
        m = manifest.new_manifest("now")
        manifest.add_workflow(
            m, "repo-a", "flows/x.json", {"name": "X", "description": "", "node_count": 1}
        )
        self.assertEqual(
            m["workflows"],
            [{"repo": "repo-a", "path": "flows/x.json", "name": "X", "description": "", "node_count": 1}],
        )

    def test_add_docs_attributes_repo(self):
        m = manifest.new_manifest("now")
        manifest.add_docs(m, "repo-a", [{"path": "README.md", "title": "T", "description": "D"}])
        self.assertEqual(
            m["docs"], [{"repo": "repo-a", "path": "README.md", "title": "T", "description": "D"}]
        )

    def test_extend_repo_top(self):
        m = manifest.new_manifest("now")
        manifest.extend_repo_top(m, [{"repo": "a", "path": "d", "description": "d"}])
        self.assertEqual(m["repo_top"], [{"repo": "a", "path": "d", "description": "d"}])


if __name__ == "__main__":
    unittest.main()
