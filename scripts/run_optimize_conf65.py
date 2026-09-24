"""Run the dynamic-exit optimizer for the 65% confidence experiment."""

import os
import runpy

os.environ["FOREX_OPT_CONFIDENCE"] = "0.65"
runpy.run_path(
    os.path.join(os.path.dirname(__file__), "optimize_dynamic_exits.py"),
    run_name="__main__",
)

