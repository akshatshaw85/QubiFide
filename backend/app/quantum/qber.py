def calculate_qber(sent_bits: str, received_bits: str) -> float:
    if len(sent_bits) != len(received_bits):
        raise ValueError("Bit strings must have equal length")
    if not sent_bits:
        raise ValueError("Cannot calculate QBER for an empty sample")
    if any(c not in "01" for c in sent_bits + received_bits):
        raise ValueError("Inputs must contain only 0 and 1")
    return sum(a != b for a, b in zip(sent_bits, received_bits)) / len(sent_bits)
