import os
import sys

import pytest

from pagelingo_parser.controller import monitor_worker, worker_environment
from pagelingo_parser.files import relative_file


def test_worker_environment_does_not_forward_application_secrets(monkeypatch, tmp_path):
    for key in ["OPENAI_API_KEY", "DATABASE_URL", "HF_TOKEN", "MINERU_MODEL_VLM_API_KEY"]:
        monkeypatch.setenv(key, "should-never-reach-parser")
    env = worker_environment(tmp_path, 4)
    assert "should-never-reach-parser" not in env.values()
    assert env["HF_HUB_OFFLINE"] == "1"
    assert env["MINERU_MODEL_SOURCE"] == "local"
    assert env["CUDA_VISIBLE_DEVICES"] == ""


def test_real_worker_exit_failure_retains_log_and_resource_result(tmp_path):
    log = tmp_path / "worker.log"
    result = monitor_worker(
        [sys.executable, "-c", "print('parse failed');raise SystemExit(7)"],
        log,
        {"PATH": os.environ["PATH"]},
        3,
    )
    assert result["exitCode"] == 7
    assert result["timedOut"] is False
    assert "parse failed" in log.read_text()


def test_real_worker_timeout_is_bounded(tmp_path):
    result = monitor_worker(
        [sys.executable, "-c", "import time;time.sleep(30)"],
        tmp_path / "worker.log",
        {"PATH": os.environ["PATH"]},
        0.3,
    )
    assert result["timedOut"] is True
    assert result["workerSeconds"] < 3
    assert result["exitCode"] != 0


@pytest.mark.parametrize("name", ["/etc/passwd", "../secret", "assets/../../secret"])
def test_asset_paths_cannot_escape_run(tmp_path, name):
    with pytest.raises(ValueError):
        relative_file(tmp_path, name)


def test_symlink_escape_is_rejected(tmp_path):
    root = tmp_path / "run"
    root.mkdir()
    (root / "assets").symlink_to(tmp_path)
    with pytest.raises(ValueError):
        relative_file(root, "assets/secret")
