"""Virtual node delivery against a fake broker: live, offline buffer, ack sync, commands, seq persistence."""

import json
import time

from coldchain_tools import envelope
from coldchain_tools.contracts import topic
from coldchain_tools.sim_engine import FridgeNode
from coldchain_tools.virtual_node import SeqFile, Uplink

SECRET = "a" * 64
PREFIX = "coldchain/v1/test"


class FakeTransport:
    def __init__(self):
        self.connected = True
        self.sent: list[tuple[str, str]] = []

    def publish(self, topic_, payload):
        self.sent.append((topic_, payload))
        return True

    def bodies(self, kind):
        out = []
        for t, p in self.sent:
            if t.endswith("/" + kind):
                reason, env = envelope.verify(p, {"fridge-07": SECRET})
                assert reason == "OK", reason
                out.append(json.loads(env["body"]))
        return out


def server_msg(kind, body, ts=None, nonce=None, secret=SECRET):
    return envelope.build(secret, "fridge-07", kind, json.dumps(body), ts=ts, nonce=nonce)


def run(node, up, seconds, start=0):
    for s in range(start, start + seconds):
        up.deliver(node.tick(s * 1000, 1.0 if s else 0.0, lambda: int(time.time())))
        up.pump(s * 1000)
    return start + seconds


def setup():
    node = FridgeNode("fridge-07", seed=5)
    tr = FakeTransport()
    return node, tr, Uplink(node, SECRET, PREFIX, tr)


def test_live_messages_are_signed_and_topic_correct():
    node, tr, up = setup()
    run(node, up, 11)
    tel = tr.bodies("telemetry")
    assert len(tel) == 3 and tel[0]["fw"] == "1.0.0" and tel[0]["buf"] == 0
    assert all(t == topic(PREFIX, "fridge-07", "telemetry") for t, _ in tr.sent)


def test_outage_buffers_then_syncs_in_order_without_gaps():
    node, tr, up = setup()
    t = run(node, up, 10)
    up.outage = True
    node.set_door(True)
    t = run(node, up, 120, t)  # 2 minutes offline, door opened meanwhile
    assert len(up.buffer) > 24
    buffered = [e["seq"] for e in up.buffer.items]
    assert any("type" in e and e["type"] == "WIFI_LOST" for e in up.buffer.items)
    up.outage = False
    synced, events = [], []
    for _ in range(10):
        t = run(node, up, 1, t)
        events += [b["type"] for b in tr.bodies("event")]
        chunks = tr.bodies("sync")
        if chunks:
            last = chunks[-1]
            synced += [r["seq"] for r in last["readings"] if r["seq"] not in synced]
            up.handle(topic(PREFIX, "fridge-07", "ack"), server_msg("ack", {"seq_upto": last["to_seq"]}))
        tr.sent.clear()
    assert synced == buffered  # all of them, oldest first, no gaps, no repeats
    assert len(up.buffer) == 0
    assert "WIFI_BACK" in events


def test_unacked_chunk_is_resent_with_fresh_nonce():
    node, tr, up = setup()
    up.outage = True
    t = run(node, up, 30)
    up.outage = False
    t = run(node, up, 1, t)
    t = run(node, up, 6, t)  # no ack within 5 s -> retry
    sends = [json.loads(p) for tp, p in tr.sent if tp.endswith("/sync")]
    assert len(sends) == 2 and sends[0]["body"] == sends[1]["body"] and sends[0]["nonce"] != sends[1]["nonce"]


def test_commands_verified_and_acked():
    node, tr, up = setup()
    node.heat.set_latch()
    cmd_topic = topic(PREFIX, "fridge-07", "cmd")
    good = server_msg("cmd", {"cmd_id": "c1", "type": "RESET_LATCH", "args": {}})
    up.handle(cmd_topic, good)
    assert not node.heat.latched
    assert tr.bodies("cmdack")[-1] == {"cmd_id": "c1", "ok": True, "detail": "latch cleared, exp_s reset"}
    assert any(b["type"] == "LATCH_RESET" for b in tr.bodies("event"))
    node.heat.set_latch()
    up.handle(cmd_topic, good)  # exact replay
    up.handle(cmd_topic, server_msg("cmd", {"cmd_id": "c2", "type": "RESET_LATCH"}, secret="b" * 64))
    up.handle(
        cmd_topic, server_msg("cmd", {"cmd_id": "c3", "type": "RESET_LATCH"}, ts=int(time.time()) - 600)
    )
    assert node.heat.latched
    assert up.rejected == {"REPLAY": 1, "BAD_SIG": 1, "STALE_TS": 1}
    up.handle(cmd_topic, server_msg("cmd", {"cmd_id": "c4", "type": "FORMAT"}))
    assert tr.bodies("cmdack")[-1]["ok"] is False


def test_seq_file_never_reuses(tmp_path):
    f = SeqFile("fridge-07", tmp_path)
    first = f.start()
    f.save(first + 7)  # crashed after saving at +7 but sending up to +19
    assert f.start() >= first + 7 + 20
