#!/usr/bin/env python3
"""Crawl the n8n ecosystem into a local corpus.

Mirrors each pinned source repo into ``corpus/repos/`` and writes a
workflow-aware manifest at ``corpus/manifest.json``. Stdlib-only.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from n8ncorpus import crawler  # noqa: E402

SOURCE_REPOS = [
    {"key": "zie619-n8n-workflows", "url": "https://github.com/Zie619/n8n-workflows.git"},
    {"key": "n8n-io-n8n-docs", "url": "https://github.com/n8n-io/n8n-docs.git"},
    {"key": "lucaswalter-n8n-ai-automations", "url": "https://github.com/lucaswalter/n8n-ai-automations.git"},
    {"key": "atharvadomale-awesome-n8n-templates", "url": "https://github.com/AtharvaDomale/awesome-n8n-templates.git"},
    {"key": "enescingoz-awesome-n8n-templates", "url": "https://github.com/enescingoz/awesome-n8n-templates.git"},
    {"key": "wassupjay-n8n-free-templates", "url": "https://github.com/wassupjay/n8n-free-templates.git"},
]


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--corpus",
        default=str(here / "corpus"),
        help="corpus directory (default: %(default)s)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-clone every repo even when the pin already matches",
    )
    args = parser.parse_args()
    crawler.crawl(Path(args.corpus), SOURCE_REPOS, force=args.force)
    print(f"Crawl complete. Manifest: {Path(args.corpus) / 'manifest.json'}")


if __name__ == "__main__":
    main()
