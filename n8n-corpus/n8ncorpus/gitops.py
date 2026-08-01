"""Thin I/O shell over git. Untested integration code."""

import os
import shutil
import stat
import subprocess
from pathlib import Path


def head_sha(url: str) -> str:
    """Resolve the commit SHA that the remote's HEAD points at."""
    out = subprocess.run(
        ["git", "ls-remote", url, "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return out.split()[0]


def clone(url: str, dest: Path) -> None:
    """Mirror a repo at its default branch, stripped of .git history."""
    safe_rmtree(dest)
    subprocess.run(
        ["git", "clone", "--depth", "1", url, str(dest)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    safe_rmtree(dest / ".git")


def safe_rmtree(path: Path) -> None:
    """Remove a tree, fixing Windows read-only flags so .git dies quietly."""
    if not path.exists():
        return
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            (Path(root) / name).chmod(stat.S_IWRITE)
    shutil.rmtree(path)
