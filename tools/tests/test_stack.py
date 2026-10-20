import pytest

from coldchain_tools.stack import parse_weak


def test_parse_weak_reads_fridge_efficiency_pairs():
    assert parse_weak([]) == {}
    assert parse_weak(["fridge-02=0.4"]) == {"fridge-02": 0.4}
    assert parse_weak(["fridge-01=1", "fridge-02=0.5"]) == {"fridge-01": 1.0, "fridge-02": 0.5}


@pytest.mark.parametrize(
    "bad", ["fridge-09=0.4", "fridge-02", "fridge-02=0", "fridge-02=1.5", "=0.4", "fridge-02=abc"]
)
def test_parse_weak_refuses_unknown_fridges_and_out_of_range_values(bad):
    with pytest.raises(SystemExit):
        parse_weak([bad])
