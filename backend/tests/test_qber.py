import pytest
from app.quantum.qber import calculate_qber

def test_qber():
    assert calculate_qber("0011", "0111") == 0.25

def test_empty_rejected():
    with pytest.raises(ValueError):
        calculate_qber("", "")
