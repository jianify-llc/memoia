"""First Worker adoption is an explicit schema step, not an infrastructure bypass."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


DIRECTORY = Path(__file__).parents[1]
RECOVERY_SPEC = importlib.util.spec_from_file_location("schema_test_recovery", DIRECTORY / "recovery.py")
recovery = importlib.util.module_from_spec(RECOVERY_SPEC)
RECOVERY_SPEC.loader.exec_module(recovery)
SCHEMA_SPEC = importlib.util.spec_from_file_location("schema_test_maintenance", DIRECTORY / "schema-maintenance.py")
schema = importlib.util.module_from_spec(SCHEMA_SPEC)
with patch.dict(sys.modules, {"recovery": recovery}):
    SCHEMA_SPEC.loader.exec_module(schema)


class WorkerAdoption(unittest.TestCase):
    def setUp(self):
        self.root = Path("/opt/memoia")
        self.backup = self.root / ".deploy/backups/fixture"
        self.before = {
            "name": "memoia-test", "networks": {"data": {"external": True, "name": "jianify-data"}},
            "services": {
                "redis": {"image": "fixed-redis", "restart": "unless-stopped"},
                "memoia": {"image": "accepted-digest", "environment": {"DATABASE_URL": "fixture-database"},
                           "volumes": [{"source": str(self.backup / "api/config.yaml"),
                                        "target": "/app/config.yaml", "read_only": True}]}},
        }
        self.after = copy.deepcopy(self.before)
        self.after["services"]["memoia"]["volumes"][0]["source"] = str(self.root / "api/config.yaml")
        self.after["services"]["maintenance"] = copy.deepcopy(self.after["services"]["memoia"])

    def check(self):
        with patch.object(schema, "run", side_effect=[json.dumps(self.before), json.dumps(self.after)]) as command:
            schema.worker_only_addition(self.root, self.backup, "accepted-digest")
        self.assertEqual(command.call_count, 2)
        self.assertIn(str(self.backup / "docker-compose.yml"), command.call_args_list[0].args[0])
        self.assertIn(str(self.root / "docker-compose.yml"), command.call_args_list[1].args[0])

    def test_only_new_worker_with_rebased_config_mount_is_allowed(self):
        self.check()

    def test_existing_worker_or_absent_new_worker_is_not_first_adoption(self):
        self.before["services"]["maintenance"] = {}
        with self.assertRaisesRegex(RuntimeError, "API-only paired backup"):
            self.check()
        self.before["services"].pop("maintenance")
        self.after["services"].pop("maintenance")
        with self.assertRaisesRegex(RuntimeError, "API-only paired backup"):
            self.check()

    def test_existing_infrastructure_or_api_contract_cannot_change(self):
        cases = [
            lambda config: config["services"]["redis"].update(image="different-redis"),
            lambda config: config["services"]["memoia"]["environment"].update(DATABASE_URL="different-db"),
            lambda config: config["networks"]["data"].update(name="different-network"),
            lambda config: config["services"]["memoia"].update(ports=["0.0.0.0:8000:8000"]),
        ]
        original = copy.deepcopy(self.after)
        for change in cases:
            with self.subTest(change=change):
                self.after = copy.deepcopy(original)
                change(self.after)
                with self.assertRaisesRegex(RuntimeError, "cannot change existing"):
                    self.check()


if __name__ == "__main__":
    unittest.main()
