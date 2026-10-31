"""Authenticated message encryption helpers."""
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes


def derive_session_key(candidate_bits: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    """Derive a 256-bit AES key from candidate bits. The demo accepts >=64 bits of
    candidate material so the default 433-qubit BB84 run can complete after
    basis sifting and test-bit disclosure. This is educational, not production security.

    NOTE: caller must only use this after a successful QBER check. In a research-
    grade QKD system, perform a properly analyzed privacy amplification protocol.
    """
    if len(candidate_bits) < 64:
        raise ValueError("Not enough candidate key material (at least 64 bits required by this educational prototype)")
    salt = salt or os.urandom(32)
    ikm = int(candidate_bits, 2).to_bytes((len(candidate_bits) + 7) // 8, "big")
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
               info=b"Q-Chat BB84 educational session key").derive(ikm)
    return key, salt


def encrypt_message(key: bytes, plaintext: str, associated_data: bytes = b"q-chat-v1") -> dict:
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), associated_data)
    return {"nonce": nonce.hex(), "ciphertext": ciphertext.hex(), "aad": associated_data.decode("utf-8")}


def decrypt_message(key: bytes, record: dict) -> str:
    plaintext = AESGCM(key).decrypt(bytes.fromhex(record["nonce"]),
                                   bytes.fromhex(record["ciphertext"]),
                                   record.get("aad", "q-chat-v1").encode("utf-8"))
    return plaintext.decode("utf-8")
