from coldchain_tools.preflight import check_batches, check_latches, skew_from_date, skew_verdict


def test_skew_verdict_warns_before_the_30_s_limit():
    assert skew_verdict(0.4) == skew_verdict(-3.0) == "PASS"
    assert skew_verdict(-4.2) == skew_verdict(9.9) == "WARN"
    assert skew_verdict(10.5) == skew_verdict(-45) == "FAIL"


def test_skew_from_http_date_header():
    date = "Sun, 18 Oct 2026 12:00:00 GMT"
    base = 1792324800.0  # 2026-10-18T12:00:00Z
    assert skew_from_date(date, base) == 0
    assert skew_from_date(date, base + 3.5) == 3.5  # local clock ahead
    assert skew_from_date(date, base - 40) == -40


def test_latches_must_match_a_fresh_demo():
    fridges = [{"id": "fridge-01", "latch": False}, {"id": "fridge-02", "latch": True}]
    assert check_latches(fridges, {"fridge-02"})[0] == "PASS"
    leftover = [{"id": "fridge-01", "latch": True}, {"id": "fridge-02", "latch": True}]
    status, detail = check_latches(leftover, {"fridge-02"})
    assert status == "FAIL" and "fridge-01" in detail


def test_batches_need_the_eight_seeded_states():
    seeded = [{"status": s} for s in ["SAFE"] * 6 + ["AT_RISK", "DISCARD"]]
    assert check_batches(seeded)[0] == "PASS"
    assert check_batches(seeded[:-1])[0] == "FAIL"  # Discard missing
    assert check_batches([{"status": "SAFE"}] * 8)[0] == "FAIL"
    assert check_batches([])[0] == "FAIL"
