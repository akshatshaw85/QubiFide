from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import secrets
import hashlib
from typing import Any

from fastapi import (
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    Depends,
    Header,
    Query,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .db import Base, engine, SessionLocal
from .models import SessionModel, MessageModel
from .quantum.bb84 import run_bb84
from .crypto.encryption import (
    derive_session_key,
    encrypt_message,
    decrypt_message,
)

keys: dict[str, bytes] = {}
socket_members: dict[str, set[WebSocket]] = {}
participant_tokens: dict[str, set[str]] = {}
exchange_summaries: dict[str, dict[str, Any]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield
    keys.clear()


app = FastAPI(
    title="QubiFide API",
    version="0.2.0",
    description="Educational BB84/Qiskit quantum-secure messaging demo",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=(
        r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class CreateSession(BaseModel):
    participant_name: str = Field(
        default="You",
        min_length=1,
        max_length=50,
    )


class JoinSession(BaseModel):
    participant_name: str = Field(
        default="Other participant",
        min_length=1,
        max_length=50,
    )


class ExchangeRequest(BaseModel):
    qubits: int = Field(default=433, ge=16, le=4096)
    eve_enabled: bool = False
    eve_probability: float = Field(default=1.0, ge=0, le=1)
    qber_threshold: float = Field(default=0.11, gt=0, lt=0.5)
    test_fraction: float = Field(default=0.20, ge=0.05, le=0.5)
    seed: int | None = None


class MessageRequest(BaseModel):
    participant_token: str
    text: str = Field(min_length=1, max_length=4000)


def safe_session(s: SessionModel):
    return {
        "session_id": s.id,
        "active": s.active,
        "participant_count": s.participant_count,
        "key_established": s.key_established,
        "qber": s.qber,
        "created_at": s.created_at,
    }


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "qubifide-api",
        "quantum_engine": "Qiskit Aer",
    }


@app.post("/api/sessions", status_code=201)
def create_session(
    body: CreateSession,
    db: Session = Depends(get_db),
):
    sid = "QCHAT-" + secrets.token_hex(3).upper()

    while db.get(SessionModel, sid):
        sid = "QCHAT-" + secrets.token_hex(3).upper()

    token = secrets.token_urlsafe(24)

    session = SessionModel(
        id=sid,
        active=True,
        participant_count=1,
    )

    db.add(session)
    db.commit()
    db.refresh(session)

    participant_tokens[sid] = {token}

    return {
        **safe_session(session),
        "participant_token": token,
        "participant_name": body.participant_name,
    }


@app.post("/api/sessions/{session_id}/join")
def join_session(
    session_id: str,
    body: JoinSession,
    db: Session = Depends(get_db),
):
    session = db.get(SessionModel, session_id)

    if not session or not session.active:
        raise HTTPException(
            status_code=404,
            detail="Session not found or inactive",
        )

    if session.participant_count >= 2:
        raise HTTPException(
            status_code=409,
            detail="This temporary session already has two participants",
        )

    token = secrets.token_urlsafe(24)

    participant_tokens.setdefault(session_id, set()).add(token)

    session.participant_count = 2

    db.commit()
    db.refresh(session)

    return {
        **safe_session(session),
        "participant_token": token,
        "participant_name": body.participant_name,
    }


@app.get("/api/sessions/{session_id}")
def get_session(
    session_id: str,
    db: Session = Depends(get_db),
):
    session = db.get(SessionModel, session_id)

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Session not found",
        )

    return safe_session(session)


@app.post("/api/sessions/{session_id}/key-exchange")
def key_exchange(
    session_id: str,
    body: ExchangeRequest,
    db: Session = Depends(get_db),
):
    session = db.get(SessionModel, session_id)

    if not session or not session.active:
        raise HTTPException(
            status_code=404,
            detail="Session not found or inactive",
        )

    if session.participant_count < 2:
        raise HTTPException(
            status_code=409,
            detail="A second participant must join before key exchange",
        )

    try:
        result = run_bb84(
            qubits=body.qubits,
            eve_enabled=body.eve_enabled,
            eve_probability=body.eve_probability,
            qber_threshold=body.qber_threshold,
            test_fraction=body.test_fraction,
            seed=body.seed,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Qiskit simulation failed: {type(exc).__name__}: {exc}",
        ) from exc

    keys.pop(session_id, None)

    if result.key_accepted and result._candidate_key:
        key, salt = derive_session_key(result._candidate_key)
        keys[session_id] = key
        session.key_salt = salt.hex()
        session.key_established = True
    else:
        session.key_salt = None
        session.key_established = False

    session.qber = result.qber
    db.commit()

    summary = {
        "session_id": session_id,
        "qubits_sent": result.qubits_sent,
        "bases_matched": result.bases_matched,
        "sifted_bits": result.sifted_bits,
        "test_bits": result.test_bits,
        "errors_in_test": result.errors_in_test,
        "qber": result.qber,
        "qber_threshold_percent": body.qber_threshold * 100,
        "eve_enabled": result.eve_enabled,
        "eve_intercept_probability": result.eve_intercept_probability,
        "simulation_engine": "Qiskit Aer",
        "key_accepted": result.key_accepted and session.key_established,
        "key_length_bits": (
            result.key_length_bits if session.key_established else 0
        ),
        "reason": result.reason,
        "chat_unlocked": session.key_established,
        "note": "Educational simulation; not a finite-key security proof.",
    }

    exchange_summaries[session_id] = summary

    return summary


@app.get("/api/sessions/{session_id}/key-exchange")
def exchange_status(session_id: str):
    if session_id not in exchange_summaries:
        raise HTTPException(
            status_code=404,
            detail="No key-exchange result for this session",
        )

    return exchange_summaries[session_id]


@app.post("/api/sessions/{session_id}/messages")
def send_message(
    session_id: str,
    body: MessageRequest,
    db: Session = Depends(get_db),
):
    session = db.get(SessionModel, session_id)

    if not session or not session.active:
        raise HTTPException(
            status_code=404,
            detail="Session not found or inactive",
        )

    if body.participant_token not in participant_tokens.get(session_id, set()):
        raise HTTPException(
            status_code=403,
            detail="Invalid participant token",
        )

    key = keys.get(session_id)

    if not session.key_established or key is None:
        raise HTTPException(
            status_code=409,
            detail="Secure key not established",
        )

    record = encrypt_message(
        key,
        body.text,
        associated_data=f"q-chat:{session_id}".encode(),
    )

    sender_fingerprint = hashlib.sha256(
        body.participant_token.encode("utf-8")
    ).hexdigest()

    message = MessageModel(
        session_id=session_id,
        sender=sender_fingerprint,
        nonce=record["nonce"],
        ciphertext=record["ciphertext"],
        aad=record["aad"],
    )

    db.add(message)
    db.commit()
    db.refresh(message)

    return {
        "id": message.id,
        "session_id": session_id,
        "nonce": message.nonce,
        "ciphertext": message.ciphertext,
        "created_at": message.created_at,
        "message": body.text,
        "encrypted_at_rest": True,
    }


@app.get("/api/sessions/{session_id}/messages")
def get_messages(
    session_id: str,
    participant_token: str | None = Query(default=None),
    participant_token_header: str | None = Header(
        default=None,
        alias="X-Participant-Token",
    ),
    db: Session = Depends(get_db),
):
    token = participant_token_header or participant_token

    session = db.get(SessionModel, session_id)

    if not session or not session.active:
        raise HTTPException(
            status_code=404,
            detail="Session not found or inactive",
        )

    if not token:
        raise HTTPException(
            status_code=401,
            detail="Missing participant token. Send X-Participant-Token.",
        )

    if token not in participant_tokens.get(session_id, set()):
        raise HTTPException(
            status_code=403,
            detail="Invalid participant token",
        )

    key = keys.get(session_id)

    if not session.key_established or key is None:
        raise HTTPException(
            status_code=409,
            detail="Secure key not established",
        )

    rows = (
        db.query(MessageModel)
        .filter(MessageModel.session_id == session_id)
        .order_by(MessageModel.id)
        .all()
    )

    token_fingerprint = hashlib.sha256(
        token.encode("utf-8")
    ).hexdigest()

    messages = []

    for message in rows:
        record = {
            "nonce": message.nonce,
            "ciphertext": message.ciphertext,
            "aad": message.aad,
        }

        messages.append({
            "id": message.id,
            "mine": message.sender == token_fingerprint,
            "message": decrypt_message(key, record),
            "created_at": message.created_at,
        })

    return {"messages": messages}


@app.delete("/api/sessions/{session_id}")
def end_session(
    session_id: str,
    db: Session = Depends(get_db),
):
    session = db.get(SessionModel, session_id)

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Session not found",
        )

    session.active = False
    session.key_established = False
    session.key_salt = None

    keys.pop(session_id, None)
    participant_tokens.pop(session_id, None)
    exchange_summaries.pop(session_id, None)
    socket_members.pop(session_id, None)

    db.commit()

    return {
        "session_id": session_id,
        "active": False,
        "key_deleted_from_memory": True,
    }


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(
    ws: WebSocket,
    session_id: str,
    token: str,
):
    await ws.accept()

    if token not in participant_tokens.get(session_id, set()):
        await ws.send_json({
            "type": "error",
            "detail": "Invalid participant token",
        })
        await ws.close(code=1008)
        return

    socket_members.setdefault(session_id, set()).add(ws)

    try:
        await ws.send_json({
            "type": "connected",
            "session_id": session_id,
        })

        while True:
            payload = await ws.receive_json()

            if payload.get("type") != "message":
                await ws.send_json({
                    "type": "error",
                    "detail": "Unsupported event",
                })
                continue

            key = keys.get(session_id)

            if key is None:
                await ws.send_json({
                    "type": "error",
                    "detail": "Secure key not established",
                })
                continue

            text = str(payload.get("text", ""))[:4000]

            if not text.strip():
                continue

            encrypted = encrypt_message(
                key,
                text,
                associated_data=f"q-chat:{session_id}".encode(),
            )

            event = {
                "type": "message",
                "session_id": session_id,
                "ciphertext": encrypted["ciphertext"],
                "nonce": encrypted["nonce"],
                "sender": "participant",
                "text": text,
            }

            for member in list(socket_members.get(session_id, set())):
                await member.send_json(event)

    except WebSocketDisconnect:
        pass
    finally:
        socket_members.get(session_id, set()).discard(ws)