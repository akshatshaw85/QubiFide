import pytest
from app.quantum.bb84 import run_bb84

@pytest.mark.slow
def test_bb84_returns_summary():
    result = run_bb84(qubits=64, eve_enabled=False, seed=7)
    assert result.qubits_sent == 64
    assert result.qber is None or 0 <= result.qber <= 1

def test_invalid_qubits():
    with pytest.raises(ValueError):
        run_bb84(qubits=4)
