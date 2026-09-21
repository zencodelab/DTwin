"""The worker's log records, and the id that ties three services together."""
import json
import logging

import pytest

from app import log as applog


@pytest.fixture(autouse=True)
def _reset():
    applog._request_id.set(None)
    yield
    applog._request_id.set(None)


def emit(capsys, level="info", event="x", **extra):
    applog.configure()
    getattr(logging.getLogger("sim"), level)(event, extra=extra)
    return json.loads(capsys.readouterr().out.strip())


def test_record_shape_matches_the_ingest_service(capsys, monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    r = emit(capsys, event="run.completed", runId="r1", zones=24)
    assert r["service"] == "sim"
    assert r["event"] == "run.completed"
    assert r["level"] == "info"
    assert r["runId"] == "r1" and r["zones"] == 24
    assert r["ts"].endswith("Z")


def test_warning_is_logged_as_warn_not_warning(capsys, monkeypatch):
    """Python's level names differ from the other service's. A consumer
    filtering on level="warn" must not silently miss this one."""
    monkeypatch.setenv("LOG_FORMAT", "json")
    assert emit(capsys, level="warning", event="ingest.rejected")["level"] == "warn"
    assert emit(capsys, level="critical", event="bad")["level"] == "error"


def test_the_request_id_is_carried_without_being_passed(capsys, monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    applog.set_request_id("req-from-the-browser")
    assert emit(capsys, event="run.started")["requestId"] == "req-from-the-browser"


def test_a_hostile_request_id_is_replaced(capsys, monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    for hostile in ["a\nb", "a b", 'a"b', "x" * 65, "", None]:
        resolved = applog.set_request_id(hostile)
        assert resolved != hostile
        assert applog._SAFE_ID.match(resolved)


def test_a_usable_caller_id_is_kept_so_a_trace_spans_services():
    assert applog.set_request_id("abc-123_XY.z") == "abc-123_XY.z"


def test_no_request_id_logs_fine(capsys, monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    assert "requestId" not in emit(capsys, event="startup")


def test_an_exception_becomes_fields(capsys, monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    applog.configure()
    try:
        raise ValueError("boom")
    except ValueError:
        logging.getLogger("sim").exception("run.failed", extra={"runId": "r2"})
    r = json.loads(capsys.readouterr().out.strip())
    assert r["errorName"] == "ValueError"
    assert r["error"] == "boom"
    assert "ValueError: boom" in r["stack"]
    assert r["runId"] == "r2"


def test_a_field_cannot_forge_a_second_record(capsys, monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    applog.configure()
    logging.getLogger("sim").info("x", extra={"note": '\n{"level":"error"}'})
    out = capsys.readouterr().out.strip()
    assert len(out.splitlines()) == 1
    assert json.loads(out)["note"] == '\n{"level":"error"}'


def test_text_format_is_for_a_human(capsys, monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "text")
    applog.configure()
    applog.set_request_id("abcdef0123")
    logging.getLogger("sim").warning("run.slow", extra={"runId": "r3"})
    line = capsys.readouterr().out.strip()
    assert line.startswith("warn  run.slow")
    assert "[abcdef01]" in line and "runId=r3" in line
