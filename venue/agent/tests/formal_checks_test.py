from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper


AGENT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_ROOT / "formal"))

from check_graph import GraphRefused, inspect_graph  # noqa: E402
from check_release import check_default_mode, check_optional_mode  # noqa: E402


class FormalChecksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model_path = AGENT_ROOT / "artifacts/model/network.onnx"
        if not cls.model_path.exists():
            raise RuntimeError("build the proof-spike model before running formal checks")

    def mutate(self, change) -> Path:
        model = onnx.load(self.model_path)
        change(model)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "mutated.onnx"
        onnx.save_model(model, path)
        return path

    def test_approved_graph_is_accepted(self):
        self.assertTrue(inspect_graph(self.model_path)["accepted"])

    def test_context_bypass_mutation_is_refused(self):
        def change(model):
            feature_indices = next(value for value in model.graph.initializer if value.name == "feature_indices")
            feature_indices.CopyFrom(numpy_helper.from_array(np.array([0, 1, 2, 3, 4, 6]), "feature_indices"))

        with self.assertRaises(GraphRefused):
            inspect_graph(self.mutate(change))

    def test_weight_mutation_is_refused(self):
        def change(model):
            weights = next(value for value in model.graph.initializer if value.name == "weights_2")
            array = numpy_helper.to_array(weights).copy()
            array[0, 0] += 1
            weights.CopyFrom(numpy_helper.from_array(array, "weights_2"))

        with self.assertRaises(GraphRefused):
            inspect_graph(self.mutate(change))

    def test_two_run_queries_are_unsatisfiable(self):
        self.assertEqual(str(check_default_mode()[0]), "unsat")
        self.assertEqual(str(check_optional_mode()[0]), "unsat")


if __name__ == "__main__":
    unittest.main()
