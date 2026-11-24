"""Offline contract checks only; does not execute module implementations."""
import json
import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def check_shape(value, schema):
    """Restricted offline checker for the exact schema keywords used here.

    Deliberately fails on unknown keywords; not a general JSON Schema engine.
    """
    supported = {"$schema", "$id", "title", "type", "additionalProperties", "required",
                 "properties", "const", "enum", "minimum", "maximum", "pattern",
                 "anyOf", "items", "uniqueItems", "maxItems"}
    assert not set(schema) - supported, f"Unsupported schema keywords: {set(schema)-supported}"
    if "anyOf" in schema:
        matches = []
        for alternative in schema["anyOf"]:
            try:
                check_shape(value, alternative)
                matches.append(True)
            except AssertionError:
                pass
        assert matches, f"No anyOf alternative accepts {value!r}"
    kind = schema.get("type")
    if kind:
        types = {"object": type(value) is dict, "array": type(value) is list,
                 "integer": type(value) is int, "number": type(value) in (int, float),
                 "boolean": type(value) is bool, "string": type(value) is str,
                 "null": value is None}
        assert types[kind], f"Expected {kind}, got {value!r}"
    if "const" in schema:
        assert value == schema["const"]
    if "enum" in schema:
        assert value in schema["enum"]
    if "minimum" in schema:
        assert value >= schema["minimum"]
    if "maximum" in schema:
        assert value <= schema["maximum"]
    if "pattern" in schema:
        assert re.fullmatch(schema["pattern"].removeprefix("^").removesuffix("$"), value)
    if kind == "object":
        assert set(schema.get("required", [])) <= value.keys(), "Missing fields"
        if schema.get("additionalProperties") is False:
            assert value.keys() <= schema["properties"].keys(), "Unknown fields"
        for key, child in schema.get("properties", {}).items():
            if key in value:
                check_shape(value[key], child)
    if kind == "array":
        assert len(value) <= schema.get("maxItems", len(value))
        if schema.get("uniqueItems"):
            assert len({json.dumps(x, sort_keys=True) for x in value}) == len(value)
        for item in value:
            check_shape(item, schema["items"])


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ (0x1021 if crc & 0x8000 else 0)) & 0xFFFF
    return crc


def check_uart_vector(wire):
    """Validate complete fixture bytes, not a firmware stream parser."""
    encoded = wire.encode("ascii")
    assert len(encoded) <= 128
    match = re.fullmatch(r"\$([^*$\r\n]+)\*([0-9A-F]{4})\r\n", wire)
    assert match
    body, crc = match.groups()
    assert crc16(body.encode("ascii")) == int(crc, 16)
    parts = body.split(",")
    assert parts[0] in ("EVQ", "EVH", "EV1")
    assert len(parts) == {"EVQ": 2, "EVH": 3, "EV1": 7}[parts[0]]
    for value in parts[1:2 if parts[0] == "EVQ" else 3]:
        assert re.fullmatch(r"[a-f0-9]{16}", value)
    if parts[0] == "EV1":
        for value in parts[3:]:
            assert re.fullmatch(r"0|[1-9][0-9]*", value)
        seq, uptime, count, valid = map(int, parts[3:])
        assert seq <= 0xFFFFFFFF and uptime <= 0xFFFFFFFF
        assert 0 <= count <= 20 and valid in (0, 1)
        assert valid or count == 0


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.schemas = {kind: read(CONTRACTS / f"{kind}.schema.json")
                        for kind in ("telemetry", "command", "ack", "status")}
        self.policy = read(CONTRACTS / "policy.json")
        self.cases = read(CONTRACTS / "examples/scenarios.json")

    def test_all_json_strictly_readable(self):
        for path in CONTRACTS.rglob("*.json"):
            with self.subTest(path=path.name):
                read(path)

    def test_positive_message_shapes(self):
        for path in (CONTRACTS / "examples").glob("*.json"):
            kind = path.name.split("_")[0]
            if kind in self.schemas:
                with self.subTest(path=path.name):
                    check_shape(read(path), self.schemas[kind])

    def test_intentionally_invalid_command(self):
        with self.assertRaises(AssertionError):
            check_shape(read(CONTRACTS / "examples/invalid_command.json"), self.schemas["command"])

    def test_strict_shape_rejects_mistakes(self):
        source = read(CONTRACTS / "examples/command_normal.json")
        mutations = [{**source, "fan_out": True}, {**source, "ttl_s": 0},
                     {**source, "v": "2.0.0"}, {**source, "secret": "unexpected"},
                     {k: v for k, v in source.items() if k != "boot_id"}]
        for message in mutations:
            with self.subTest(message=message):
                with self.assertRaises(AssertionError):
                    check_shape(message, self.schemas["command"])

    def test_validity_and_units_in_telemetry_fixtures(self):
        for path in (CONTRACTS / "examples").glob("telemetry_*.json"):
            msg = read(path)
            for value, valid in (("count", "vision_valid"), ("temp_c", "temp_valid"),
                                 ("humidity_pct", "humidity_valid")):
                self.assertEqual(msg[value] is not None, msg[valid])
            self.assertEqual(msg["ts"] is not None, msg["time_valid"])
            if msg["vision_valid"]:
                self.assertLess(msg["vision_age_ms"], self.policy["uart"]["vision_stale_ms"])
            if msg["temp_valid"]:
                self.assertLess(msg["temp_age_ms"], self.policy["control"]["temp_stale_ms"])
            if msg["mode"] != "REMOTE":
                self.assertEqual(msg["hold_remaining_s"], 0)
            if msg["net_state"] == "OFFLINE":
                self.assertIn("NET_OFFLINE", msg["faults"])

    def test_command_fixture_mode_and_lease(self):
        for path in (CONTRACTS / "examples").glob("command_*.json"):
            msg = read(path)
            if msg["mode"] == "AUTO":
                self.assertEqual((msg["fan_out"], msg["led_out"], msg["hold_s"]), (None, None, 0))
            else:
                self.assertIsNotNone(msg["fan_out"])
                self.assertIsNotNone(msg["led_out"])
                self.assertGreaterEqual(msg["hold_s"], self.policy["control"]["hold_min_s"])

    def test_ack_fixture_correlations(self):
        command = read(CONTRACTS / "examples/command_normal.json")
        ack = read(CONTRACTS / "examples/ack_applied.json")
        for key in ("device_id", "boot_id", "cmd_id", "control_epoch", "mode", "fan_out", "led_out"):
            self.assertEqual(command[key], ack[key])
        for path in (CONTRACTS / "examples").glob("ack_*.json"):
            item = read(path)
            self.assertEqual(item["status"] == "APPLIED", item["reason"] == "OK")

    def test_uart_crc_and_frame_vectors(self):
        fixtures = read(CONTRACTS / "examples/uart.json")
        self.assertEqual(f"{crc16(b'123456789'):04X}", fixtures["crc_check"]["expected"])
        for case in fixtures["frames"]:
            with self.subTest(case=case["name"]):
                if case["valid_frame"]:
                    check_uart_vector(case["wire"])
                else:
                    with self.assertRaises(AssertionError):
                        check_uart_vector(case["wire"])

    def test_fragment_fixture_reconstructs_exact_bytes(self):
        fixtures = read(CONTRACTS / "examples/uart.json")
        normal = next(x["wire"] for x in fixtures["frames"] if x["name"] == "normal")
        fragmented = next(x for x in fixtures["stream_cases"] if x["name"] == "fragmented")
        self.assertEqual("".join(fragmented["chunks"]), normal)

    def test_scenario_input_shapes(self):
        for case in self.cases["scenarios"]:
            for step in case["steps"]:
                if step["event"] == "receive":
                    with self.subTest(case=case["name"]):
                        if case["name"] == "invalid":
                            with self.assertRaises(AssertionError):
                                check_shape(step["command"], self.schemas["command"])
                        else:
                            check_shape(step["command"], self.schemas["command"])

    def test_expired_fixture_uses_exclusive_boundary(self):
        case = next(x for x in self.cases["scenarios"] if x["name"] == "expired_at_boundary")
        step = case["steps"][0]
        self.assertEqual(step["now"], step["command"]["issued_at"] + step["command"]["ttl_s"])
        self.assertEqual(case["expect"]["reason"], "EXPIRED")

    def test_duplicate_fixtures_preserve_content(self):
        for case in self.cases["scenarios"]:
            if case["name"].startswith("duplicate"):
                receives = [x for x in case["steps"] if x["event"] == "receive"]
                self.assertEqual(receives[0]["command"], receives[1]["command"])
                self.assertEqual(case["expect"]["executions"], 1)
                self.assertTrue(case["expect"]["ack_replayed"])

    def test_network_loss_fixture_spans_lease(self):
        case = next(x for x in self.cases["scenarios"] if x["name"] == "network_loss")
        command = case["steps"][0]["command"]
        offline, advance, online = case["steps"][1:]
        self.assertLess(offline["at"], advance["now"])
        self.assertLess(advance["now"], online["at"])
        self.assertEqual(advance["now"], self.cases["fixture_now"] + command["hold_s"])
        self.assertFalse(case["expect"]["replay_queued_commands"])

    def test_policy_matches_schema_limits_and_topics(self):
        props = self.schemas["command"]["properties"]
        self.assertEqual(props["hold_s"]["maximum"], self.policy["control"]["hold_max_s"])
        self.assertEqual(props["ttl_s"]["maximum"], self.policy["control"]["ttl_max_s"])
        for name, topic in self.policy["mqtt"]["topics"].items():
            self.assertEqual(topic["qos"], 1)
            self.assertEqual(topic["retain"], name == "status")
        self.assertEqual(self.policy["mqtt"]["topics"]["command"]["suffix"], "cmd")

    def test_lwt_sequence_follows_online(self):
        online = read(CONTRACTS / "examples/status_online.json")
        lwt = read(CONTRACTS / "examples/status_lwt.json")
        self.assertEqual(online["boot_id"], lwt["boot_id"])
        self.assertEqual(lwt["seq"], online["seq"] + 1)
        self.assertIsNone(lwt["ts"])
        self.assertEqual(lwt["state"], "offline")

    def test_fixture_messages_fit_payload_budget(self):
        for path in (CONTRACTS / "examples").glob("*.json"):
            if path.name.split("_")[0] in self.schemas:
                data = json.dumps(read(path), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.assertLessEqual(len(data), self.policy["mqtt"]["max_payload_bytes"])

    def test_present_k230_protocol_matches_public_vectors(self):
        path = ROOT / "firmware/k230/protocol.py"
        if not path.is_file():
            self.skipTest("K230 module not delivered; public checks remain independent")
        spec = importlib.util.spec_from_file_location("ecovision_review_protocol", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixtures = read(CONTRACTS / "examples/uart.json")
        frames = {x["name"]: x["wire"].encode("ascii") for x in fixtures["frames"]}
        link = module.VisionLink("000000000000000b")
        self.assertEqual(link.receive(frames["query"], 0), [frames["hello"]])
        link.seq = 1
        self.assertEqual(link.sample(2, True, 1000), frames["normal"])
        self.assertEqual(link.sample(None, False, 2000), frames["invalid_detection"])


if __name__ == "__main__":
    unittest.main()
