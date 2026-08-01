import unittest

from n8ncorpus import workflows

WORKFLOW = """{
  "name": "Slack Notify",
  "nodes": [{"name": "Trigger"}, {"name": "Slack"}],
  "connections": {"Trigger": [{"node": "Slack", "type": "main"}]}
}"""


class WorkflowDetectionTest(unittest.TestCase):
    def test_detects_workflow_json(self):
        self.assertTrue(workflows.is_workflow(WORKFLOW))

    def test_rejects_missing_structural_keys(self):
        self.assertFalse(workflows.is_workflow('{"name": "x"}'))
        self.assertFalse(workflows.is_workflow('{"nodes": []}'))
        self.assertFalse(workflows.is_workflow('{"name": "x", "nodes": []}'))
        self.assertFalse(workflows.is_workflow('{"name": "x", "nodes": [], "connections": {}}'[::-1]))

    def test_rejects_invalid_json(self):
        self.assertFalse(workflows.is_workflow("not json {"))

    def test_rejects_wrong_types(self):
        self.assertFalse(workflows.is_workflow('{"name": "x", "nodes": "nope", "connections": {}}'))
        self.assertFalse(workflows.is_workflow('{"name": 3, "nodes": [], "connections": {}}'))

    def test_connections_may_be_empty(self):
        self.assertTrue(
            workflows.is_workflow('{"name": "x", "nodes": [], "connections": {}}')
        )


class WorkflowMetadataTest(unittest.TestCase):
    def test_extracts_name_and_node_count(self):
        meta = workflows.workflow_metadata(WORKFLOW)
        self.assertEqual(meta["name"], "Slack Notify")
        self.assertEqual(meta["node_count"], 2)
        self.assertEqual(meta["description"], "")

    def test_description_optional(self):
        meta = workflows.workflow_metadata(
            '{"name": "x", "nodes": [1], "connections": {}, "description": "does a thing"}'
        )
        self.assertEqual(meta["description"], "does a thing")


class WorkflowEntriesTest(unittest.TestCase):
    def test_collects_only_workflow_files(self):
        entries = workflows.workflow_entries(
            [
                ("flows/slack.json", WORKFLOW),
                ("data/config.json", '{"version": 2}'),
                ("README.md", "not json"),
            ]
        )
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["path"], "flows/slack.json")
        self.assertEqual(entries[0]["name"], "Slack Notify")
        self.assertIn("hash", entries[0])


if __name__ == "__main__":
    unittest.main()
