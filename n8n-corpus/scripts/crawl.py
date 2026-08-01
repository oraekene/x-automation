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
    parser.add_argument(
        "--only",
        default="",
        help="comma-separated source repo keys to crawl (default: all six)",
    )
    parser.add_argument(
        "--no-follow",
        action="store_true",
        help="skip following workflow links (use when the fetch transport is blocked)",
    )
    args = parser.parse_args()
    repos = SOURCE_REPOS
    if args.only:
        keys = [k.strip() for k in args.only.split(",") if k.strip()]
        by_key = {r["key"]: r for r in SOURCE_REPOS}
        unknown = [k for k in keys if k not in by_key]
        if unknown:
            parser.error(f"unknown repo keys: {', '.join(unknown)}")
        repos = [by_key[k] for k in keys]
    crawler.crawl(Path(args.corpus), repos, force=args.force, follow=not args.no_follow)
    print(f"Crawl complete. Manifest: {Path(args.corpus) / 'manifest.json'}")


if __name__ == "__main__":
    main()
