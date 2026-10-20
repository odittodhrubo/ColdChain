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


def test_sync_request_replays_a_gap_the_backend_missed_while_down():
    """R1: published live while the backend was down (the broker dropped it); the backend finds the gap and
    asks for that range; the node resends it from its replay window, in order, and nothing outside it."""
    node, tr, up = setup()
    t = run(node, up, 60)
    sent = [b["seq"] for b in tr.bodies("telemetry")] + [b["seq"] for b in tr.bodies("event")]
    assert len(up.recent) == len(sent) and len(up.buffer) == 0  # delivered live, still replayable
    gap = sorted(sent)[3:7]  # the backend was down for these
    cmd = {"cmd_id": "c1", "type": "SYNC_REQUEST", "args": {"from_seq": gap[0], "to_seq": gap[-1]}}
    tr.sent.clear()
    up.handle(topic(PREFIX, "fridge-07", "cmd"), server_msg("cmd", cmd))
    assert "4 replayed" in tr.bodies("cmdack")[0]["detail"]
    run(node, up, 1, t)
    chunk = tr.bodies("sync")[-1]
    assert [r["seq"] for r in chunk["readings"]] == gap
    assert (chunk["from_seq"], chunk["to_seq"]) == (gap[0], gap[-1])
    up.handle(topic(PREFIX, "fridge-07", "ack"), server_msg("ack", {"seq_upto": gap[-1]}))
    kept = {e["seq"] for e in up.recent.items}
    assert len(up.buffer) == 0 and not kept & set(gap) and set(sent) - set(gap) <= kept


def test_ack_never_frees_an_entry_replayed_after_its_chunk_went_out():
    from coldchain_tools.sim_engine import RingBuffer, Syncer

    recent, buf = RingBuffer(), RingBuffer()
    sync = Syncer(buf)
    for s in range(150, 161):
        recent.push({"seq": s})
    for s in range(200, 220):
        buf.push({"seq": s})
    assert sync.due(0, True)
    sync.sent(0)  # chunk 200..219 in flight
    assert recent.move_range_to(buf, 150, 160) == 11
    assert sync.on_ack(219)
    assert [e["seq"] for e in buf.items] == list(range(150, 161))
    assert buf.insert_sorted({"seq": 155}) and len(buf) == 11  # duplicate: no-op


def test_rotate_secret_switches_keys_and_acks_with_the_new_one():
    """S7: the cmdack is signed with the new key (the server's proof); the old key is refused afterwards."""
    from coldchain_tools.envelope import rotate_seal

    node, tr, up = setup()
    new = "b" * 63 + "1"
    nonce = "0123456789abcdef0123456789abcdef"
    ct, tag = rotate_seal(SECRET, new, nonce)
    cmd = {"cmd_id": "r1", "type": "ROTATE_SECRET", "args": {"nonce": nonce, "ct": ct, "tag": tag}}
    up.handle(topic(PREFIX, "fridge-07", "cmd"), server_msg("cmd", cmd))
    acks = [(t, p) for t, p in tr.sent if t.endswith("/cmdack")]
    reason, env = envelope.verify(acks[-1][1], {"fridge-07": new})
    assert reason == "OK" and json.loads(env["body"])["ok"] is True
    assert envelope.verify(acks[-1][1], {"fridge-07": SECRET})[0] == "BAD_SIG"
    # a command still signed with the old secret is refused now
    up.handle(topic(PREFIX, "fridge-07", "cmd"), server_msg("cmd", {"cmd_id": "c2", "type": "BUZZER_TEST"}))
    assert up.rejected.get("BAD_SIG") == 1
    # a seal that does not verify leaves the key alone
    up.handle(
        topic(PREFIX, "fridge-07", "cmd"),
        server_msg(
            "cmd",
            {"cmd_id": "r2", "type": "ROTATE_SECRET", "args": {"nonce": nonce, "ct": ct, "tag": "0" * 64}},
            secret=new,
        ),
    )
    assert up.secret == new and up.rejected.get("BAD_ROTATION") == 1


def test_runner_applies_web_manual_controls_from_the_sim_topic(monkeypatch):
    """The web app's POST /api/fridges/:id/sim lands on <prefix>/<device_id>/sim and the node applies it."""
    import queue

    from coldchain_tools import virtual_node

    class Transport(FakeTransport):
        def __init__(self, *args):  # same positional signature; the last is the subscribe list
            super().__init__()
            self.subscribe = args[-1]
            self.inbox: queue.Queue[tuple[str, str]] = queue.Queue()
            self.outages: list[bool] = []

        def set_outage(self, on):
            self.outages.append(on)

    monkeypatch.setattr(virtual_node, "MqttTransport", Transport)
    runner = virtual_node.NodeRunner("fridge-07", SECRET, "mqtt://x", "", "", PREFIX, boot_lock=False)
    sim = f"{PREFIX}/fridge-07/sim"
    assert sim in runner.transport.subscribe
    msgs = ({"action": "door", "arg": True}, {"action": "hold", "arg": 11.5}, {"action": "wifi", "arg": True})
    for msg in msgs:
        runner.transport.inbox.put((sim, json.dumps(msg)))
    runner.transport.inbox.put((sim, "not json"))  # ignored, the loop keeps going
    runner.step()
    assert runner.node.door_open and runner.node.hold == 11.5
    assert runner.uplink.outage and runner.transport.outages == [True]
