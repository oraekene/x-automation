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
        ["git", "-c", "core.longpaths=true", "clone", "--depth", "1", url, str(dest)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    safe_rmtree(dest / ".git")


def safe_rmtree(path: Path) -> None:
    """Remove a tree, fixing Windows read-only flags so .git dies quietly.

    Uses the ``\\\\?\\`` long-path prefix on Windows so paths longer than
    MAX_PATH (260 chars) can be removed — some source repos ship such files.
    """
    target = os.path.abspath(str(path))
    if os.name == "nt" and not target.startswith("\\\\?\\"):
        target = "\\\\?\\" + target
    if not os.path.exists(target):
        return
    for root, dirs, files in os.walk(target):
        for name in dirs + files:
            os.chmod(os.path.join(root, name), stat.S_IWRITE)
    shutil.rmtree(target)
