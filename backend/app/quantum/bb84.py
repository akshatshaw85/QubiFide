from __future__ import annotations

from dataclasses import dataclass
import secrets
import random
from typing import Optional

from qiskit import QuantumCircuit, transpile
from qiskit_aer import AerSimulator


@dataclass
class BB84Result:
    qubits_sent: int
    bases_matched: int
    sifted_bits: int
    test_bits: int
    errors_in_test: int
    qber: Optional[float]
    eve_enabled: bool
    eve_intercept_probability: float
    key_accepted: bool
    key_length_bits: int
    reason: str
    _candidate_key: str = ""


def _bit_from_counts(counts: dict[str, int]) -> int:
    return int(next(iter(counts)).replace(" ", "")[-1])


def run_bb84(
    qubits: int = 433,
    eve_enabled: bool = False,
    eve_probability: float = 1.0,
    qber_threshold: float = 0.11,
    test_fraction: float = 0.20,
    seed: int | None = None,
) -> BB84Result:
    if not 16 <= qubits <= 4096:
        raise ValueError("qubits must be between 16 and 4096")
    if not 0.0 <= eve_probability <= 1.0:
        raise ValueError("eve_probability must be between 0 and 1")
    if not 0.0 < qber_threshold < 0.5:
        raise ValueError("qber_threshold must be between 0 and 0.5")
    if not 0.05 <= test_fraction <= 0.5:
        raise ValueError("test_fraction must be between 0.05 and 0.5")

    rng = random.Random(seed) if seed is not None else secrets.SystemRandom()
    bits = [rng.randrange(2) for _ in range(qubits)]
    prep_bases = [rng.randrange(2) for _ in range(qubits)]
    recv_bases = [rng.randrange(2) for _ in range(qubits)]
    attacked = [bool(eve_enabled and rng.random() < eve_probability) for _ in range(qubits)]
    eve_bases = [rng.randrange(2) if attacked[i] else 0 for i in range(qubits)]

    simulator = AerSimulator()
    first_batch: list[QuantumCircuit] = []
    first_map: list[tuple[int, str]] = []

    for i in range(qubits):
        qc = QuantumCircuit(1, 1)
        if bits[i]:
            qc.x(0)
        if prep_bases[i] == 1:
            qc.h(0)
        if attacked[i]:
            if eve_bases[i] == 1:
                qc.h(0)
            qc.measure(0, 0)
            first_map.append((i, "eve"))
        else:
            if recv_bases[i] == 1:
                qc.h(0)
            qc.measure(0, 0)
            first_map.append((i, "bob"))
        first_batch.append(qc)

    compiled = transpile(first_batch, simulator)
    first_result = simulator.run(compiled, shots=1, seed_simulator=seed).result()
    eve_bits: dict[int, int] = {}
    measured: list[int | None] = [None] * qubits

    for batch_idx, (original_idx, kind) in enumerate(first_map):
        value = _bit_from_counts(first_result.get_counts(batch_idx))
        if kind == "eve":
            eve_bits[original_idx] = value
        else:
            measured[original_idx] = value

    resend_batch: list[QuantumCircuit] = []
    resend_map: list[int] = []

    for i in range(qubits):
        if not attacked[i]:
            continue
        qc = QuantumCircuit(1, 1)
        if eve_bits[i]:
            qc.x(0)
        if eve_bases[i] == 1:
            qc.h(0)
        if recv_bases[i] == 1:
            qc.h(0)
        qc.measure(0, 0)
        resend_batch.append(qc)
        resend_map.append(i)

    if resend_batch:
        compiled_resend = transpile(resend_batch, simulator)
        resend_result = simulator.run(
            compiled_resend,
            shots=1,
            seed_simulator=(seed + 1 if seed is not None else None),
        ).result()
        for batch_idx, original_idx in enumerate(resend_map):
            measured[original_idx] = _bit_from_counts(
                resend_result.get_counts(batch_idx)
            )

    matching = [
        i for i in range(qubits)
        if prep_bases[i] == recv_bases[i]
    ]
    sifted = [
        int(measured[i])
        for i in matching
        if measured[i] is not None
    ]
    sifted_source_bits = [
        bits[i]
        for i in matching
        if measured[i] is not None
    ]

    if len(sifted) < 8:
        return BB84Result(
            qubits,
            len(matching),
            len(sifted),
            0,
            0,
            None,
            eve_enabled,
            eve_probability,
            False,
            0,
            "Insufficient sifted bits for a meaningful test.",
        )

    positions = list(range(len(sifted)))
    rng.shuffle(positions)
    test_count = max(
        4,
        min(len(sifted) - 4, int(round(len(sifted) * test_fraction))),
    )
    test_positions = set(positions[:test_count])
    errors = sum(
        sifted[j] != sifted_source_bits[j]
        for j in test_positions
    )
    qber = errors / test_count
    candidate = "".join(
        str(sifted[j])
        for j in range(len(sifted))
        if j not in test_positions
    )

    accepted = qber <= qber_threshold and len(candidate) >= 64

    if not accepted:
        reason = (
            "QBER exceeds threshold."
            if qber > qber_threshold
            else "Insufficient candidate key material (at least 64 bits required in this educational prototype)."
        )
        candidate = ""
    else:
        reason = "QBER within threshold; candidate key available for demo key derivation."

    return BB84Result(
        qubits_sent=qubits,
        bases_matched=len(matching),
        sifted_bits=len(sifted),
        test_bits=test_count,
        errors_in_test=errors,
        qber=qber,
        eve_enabled=eve_enabled,
        eve_intercept_probability=eve_probability,
        key_accepted=accepted,
        key_length_bits=256 if accepted else 0,
        reason=reason,
        _candidate_key=candidate,
    )