"""Encrypted-at-rest cookie store for X sessions (ticket 05).

An X session (auth_token + ct0) never leaves the machine and is never written
to disk in plaintext. A Fernet key lives in a sibling ``<store>.key`` file
(with 0600 permissions on POSIX); the ciphertext lives in the store file.

Boundary: the key sits beside the ciphertext, so this guards against reads of
the store file in isolation (diffs, stray copies, scanners), not against
someone with read access to the whole relay directory. Treat it as tamper
evidence and casual-read protection rather than a strong security boundary.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

REQUIRED_KEYS = ("auth_token", "ct0")


class CookieStoreError(RuntimeError):
    """A cookie store could not be read, written, or decrypted."""


class CookieStore:
    def __init__(self, path: str | Path, key_path: str | Path | None = None):
        self.path = Path(path)
        self.key_path = Path(key_path) if key_path is not None else self.path.with_suffix(self.path.suffix + ".key")

    def load(self) -> dict[str, object]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self._load_or_create_fernet().decrypt(self.path.read_bytes()).decode("utf-8"))
        except (InvalidToken, json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
            raise CookieStoreError(f"cannot decrypt cookie store {self.path}: {e}") from e
        if not isinstance(payload, dict):
            raise CookieStoreError(f"{self.path} did not contain a cookie object")
        return payload

    def save(self, cookies: dict[str, object]) -> None:
        missing = [k for k in REQUIRED_KEYS if not cookies.get(k)]
        if missing:
            raise CookieStoreError(f"required cookie keys missing: {', '.join(missing)}")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        ciphertext = self._load_or_create_fernet().encrypt(json.dumps(cookies).encode("utf-8"))
        self.path.write_bytes(ciphertext)

    def _load_or_create_fernet(self) -> Fernet:
        if not self.key_path.exists():
            return Fernet(self._create_key())
        try:
            key = self.key_path.read_text(encoding="utf-8").strip()
        except OSError as e:
            raise CookieStoreError(f"cannot read key file {self.key_path}") from e
        if os.name == "posix":
            # Enforce the same 0600 the create path sets: a restored or copied
            # key must not keep looser permissions.
            os.chmod(self.key_path, 0o600)
        try:
            return Fernet(key)
        except ValueError as e:
            raise CookieStoreError(f"invalid key file {self.key_path}") from e

    def _create_key(self) -> str:
        key = Fernet.generate_key().decode("ascii")
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        self.key_path.write_text(key, encoding="utf-8")
        if os.name == "posix":
            os.chmod(self.key_path, 0o600)
        return key