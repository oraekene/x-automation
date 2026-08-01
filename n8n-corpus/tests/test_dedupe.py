import unittest

from n8ncorpus import dedupe

FLOW_A = '{"name": "A", "nodes": [{"name": "T"}], "connections": {} }'
FLOW_A_REORDERED = '{"connections": {}, "nodes": [{"name": "T"}], "name": "A"}'
FLOW_B = '{"name": "B", "nodes": [], "connections": {}}'

HASH_A = dedupe.canonical_hash(FLOW_A)
HASH_B = dedupe.canonical_hash(FLOW_B)


class CanonicalHashTest(unittest.TestCase):
    def test_same_workflow_same_hash_ignoring_whitespace_and_key_order(self):
        self.assertEqual(
            dedupe.canonical_hash(FLOW_A), dedupe.canonical_hash(FLOW_A_REORDERED)
        )

    def test_different_workflow_different_hash(self):
        self.assertNotEqual(HASH_A, HASH_B)

    def test_non_json_text_hashes_as_is(self):
        self.assertEqual(dedupe.canonical_hash("junk"), dedupe.canonical_hash("junk"))
        self.assertNotEqual(dedupe.canonical_hash("junk"), dedupe.canonical_hash("junk2"))


class ResolveDedupesTest(unittest.TestCase):
    def test_mirror_match_resolves_to_mirror_path(self):
        mirror = [{"repo": "repo-a", "path": "flows/dup.json", "hash": HASH_A}]
        followed = [{"workflow_path": "fetched/repo-b/1.json", "hash": HASH_A}]
        self.assertEqual(
            dedupe.resolve_dedupes(mirror, followed),
            [{"status": "mirror", "resolves_to": "repos/repo-a/flows/dup.json"}],
        )

    def test_unique_workflow_is_stored(self):
        followed = [{"workflow_path": "fetched/repo-b/1.json", "hash": HASH_B}]
        self.assertEqual(
            dedupe.resolve_dedupes([], followed),
            [{"status": "stored", "resolves_to": ""}],
        )

    def test_duplicate_followed_collapses_to_alias_of_first(self):
        followed = [
            {"workflow_path": "fetched/repo-b/1.json", "hash": HASH_B},
            {"workflow_path": "fetched/repo-b/2.json", "hash": HASH_B},
        ]
        self.assertEqual(
            dedupe.resolve_dedupes([], followed),
            [
                {"status": "stored", "resolves_to": ""},
                {"status": "alias", "resolves_to": "fetched/repo-b/1.json"},
            ],
        )

    def test_mirror_copy_wins_even_over_earlier_followed(self):
        mirror = [{"repo": "repo-a", "path": "flows/x.json", "hash": HASH_B}]
        followed = [
            {"workflow_path": "fetched/repo-b/1.json", "hash": HASH_B},
            {"workflow_path": "fetched/repo-b/2.json", "hash": HASH_B},
        ]
        resolutions = dedupe.resolve_dedupes(mirror, followed)
        self.assertEqual(
            resolutions,
            [
                {"status": "mirror", "resolves_to": "repos/repo-a/flows/x.json"},
                {"status": "mirror", "resolves_to": "repos/repo-a/flows/x.json"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
