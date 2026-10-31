from app.crypto.encryption import derive_session_key, encrypt_message, decrypt_message


def test_aes_gcm_roundtrip():
    key = b"x" * 32
    rec = encrypt_message(key, "hello", b"test")
    assert decrypt_message(key, rec) == "hello"


def test_unique_nonces():
    key = b"x" * 32
    assert encrypt_message(key, "a")["nonce"] != encrypt_message(key, "b")["nonce"]


def test_demo_key_derivation_accepts_default_bb84_candidate_size():
    key, salt = derive_session_key("10101010" * 8)
    assert len(key) == 32
    assert len(salt) == 32
