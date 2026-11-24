"""Read-only comparison against the owning public schemas and examples."""
import importlib.util
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('contracts_check', ROOT / 'tests/integration/test_contracts.py')
contracts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contracts)


class Compatibility(unittest.TestCase):
    def test_generated_scenarios_match_public_telemetry_schema(self):
        script = """
        import {readFileSync} from 'node:fs';
        import {Simulation} from './sandbox/src/model.mjs';
        const p=JSON.parse(readFileSync('contracts/policy.json'));
        const scenarios=JSON.parse(readFileSync('sandbox/scenarios.json'));
        const output=[new Simulation(p).snapshot()];
        for(const data of Object.values(scenarios)) output.push(Simulation.replay(p,data).snapshot());
        console.log(JSON.stringify(output));
        """
        output = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                                check=True, capture_output=True, text=True)
        snapshots = json.loads(output.stdout)
        schema = contracts.read(ROOT / 'contracts/telemetry.schema.json')
        for sample in snapshots:
            contracts.check_shape(sample, schema)
            self.assertEqual(sample['v'], '1.0.0')
            self.assertEqual(sample['vision_valid'], sample['count'] is not None)
            self.assertEqual(sample['temp_valid'], sample['temp_c'] is not None)
        self.assertEqual(snapshots[1]['fan_out'], 1)
        self.assertEqual(snapshots[2]['led_out'], 0)
        self.assertEqual(snapshots[3]['occupancy'], 'UNKNOWN')
        self.assertEqual(snapshots[3]['fan_out'], 0)
        self.assertEqual(snapshots[4]['net_state'], 'OFFLINE')


if __name__ == '__main__':
    unittest.main()
