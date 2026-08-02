"""Cookie store at-rest encryption tests (ticket 05)."""

import os

import pytest

import cookiestore


def test_round_trip_survives_restart(tmp_path):
    cookies = {"auth_token": "at-Abc123", "ct0": "ctr-xyz"}
    first = cookiestore.CookieStore(tmp_path / "store.bin")
    first.save(cookies)
    # A fresh instance reading the same files simulates a process restart.
    second = cookiestore.CookieStore(tmp_path / "store.bin")
    assert second.load() == cookies


def test_cookies_not_stored_in_plaintext(tmp_path):
    store_path = tmp_path / "store.bin"
    cookiestore.CookieStore(store_path).save({"auth_token": "super-secret", "ct0": "ctr"})
    raw = store_path.read_text(encoding="utf-8")
    assert "super-secret" not in raw
    assert "auth_token" not in raw


def test_key_file_generated_beside_store(tmp_path):
    store_path = tmp_path / "store.bin"
    cookiestore.CookieStore(store_path).save({"auth_token": "a", "ct0": "b"})
    assert (tmp_path / "store.bin.key").exists()
    if os.name == "posix":
        assert oct(os.stat(tmp_path / "store.bin.key").st_mode & 0o777) == "0o600"


def test_returns_empty_for_missing_store(tmp_path):
    store = cookiestore.CookieStore(tmp_path / "nope.bin")
    assert store.load() == {}


def test_tampered_ciphertext_raises(tmp_path):
    store = cookiestore.CookieStore(tmp_path / "store.bin")
    store.save({"auth_token": "a", "ct0": "b"})
    (tmp_path / "store.bin").write_bytes(b"garbage-that-is-not-valid-ciphertext")
    with pytest.raises(cookiestore.CookieStoreError):
        cookiestore.CookieStore(tmp_path / "store.bin").load()


def test_missing_required_cookie_keys_rejected(tmp_path):
    store = cookiestore.CookieStore(tmp_path / "store.bin")
    with pytest.raises(cookiestore.CookieStoreError):
        store.save({"auth_token": "a"})


def test_key_permissions_reenforced_on_reload(tmp_path):
    if os.name != "posix":
        return
    store_path = tmp_path / "store.bin"
    key_path = tmp_path / "store.bin.key"
    cookiestore.CookieStore(store_path).save({"auth_token": "a", "ct0": "b"})
    os.chmod(key_path, 0o644)
    assert oct(os.stat(key_path).st_mode & 0o777) == "0o644"
    # A subsequent open (via save) must tighten the loose key back to 0600.
    cookiestore.CookieStore(store_path).save({"auth_token": "a", "ct0": "b"})
    assert oct(os.stat(key_path).st_mode & 0o777) == "0o600"