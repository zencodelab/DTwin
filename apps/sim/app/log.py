"""Structured logging for the worker, matching the ingest service's shape.

One request id follows a browser click through three services: the dashboard
mints or forwards it, the web proxy sends it here as `X-Request-Id`, and this
worker sends it back to ingest on `/internal/sim-event`. Grepping one id
returns the whole story of one click, which is the entire point — a run that
failed is otherwise three unrelated log files with no shared key.

The record shape is deliberately identical to `apps/ingest/src/log.ts`: `ts`,
`level`, `service`, `event`, then named fields. Two services logging the same
things under different key names would need a translation layer in whatever
reads them, and that layer would be the thing that rots.

A `ContextVar` carries the id, for the same reason the TypeScript side uses
`AsyncLocalStorage`: it survives across awaits and into the thread a
background run executes on, so nothing has to thread it through a signature
that has no other use for it. A run started by one request keeps that
request's id for its whole life, including the parts that finish long after
the HTTP response.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import uuid
from contextvars import ContextVar
from typing import Any

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)

# Python says WARNING where the TypeScript side says warn, and CRITICAL has no
# counterpart at all. Mapped here rather than left to whatever reads the logs:
# a filter for level="warn" that silently misses half the services is the kind
# of gap nobody notices until the night it matters.
_LEVEL_NAMES = {
    "DEBUG": "debug", "INFO": "info", "WARNING": "warn",
    "ERROR": "error", "CRITICAL": "error",
}

# Same rule as the ingest service. An id is caller-supplied, so it is bounded
# and restricted to characters that cannot forge a log line or drive a
# terminal. Anything else is replaced rather than refused: the id is
# diagnostic, and failing a simulation over a malformed header is a poor trade.
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def safe_request_id(value: str | None) -> str:
    return value if value and _SAFE_ID.match(value) else str(uuid.uuid4())


def set_request_id(value: str | None) -> str:
    resolved = safe_request_id(value)
    _request_id.set(resolved)
    return resolved


def get_request_id() -> str | None:
    return _request_id.get()


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S") + f".{int(record.msecs):03d}Z",
            "level": _LEVEL_NAMES.get(record.levelname, record.levelname.lower()),
            "service": "sim",
            "event": record.getMessage(),
        }
        request_id = _request_id.get()
        if request_id:
            payload["requestId"] = request_id
        # Anything passed as `extra=`. Skipping the standard attributes is what
        # keeps the record to the fields someone deliberately attached.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info and record.exc_info[1] is not None:
            err = record.exc_info[1]
            payload["errorName"] = type(err).__name__
            payload["error"] = str(err)
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class _TextFormatter(logging.Formatter):
    """For a human watching a dev server. Not what a machine reads."""

    def format(self, record: logging.LogRecord) -> str:
        request_id = _request_id.get()
        marker = f" [{request_id[:8]}]" if request_id else ""
        fields = " ".join(
            f"{k}={v}" for k, v in record.__dict__.items()
            if k not in _RESERVED and not k.startswith("_")
        )
        level = _LEVEL_NAMES.get(record.levelname, record.levelname.lower())
        line = f"{level:<5} {record.getMessage()}{marker}"
        if fields:
            line += f" {fields}"
        if record.exc_info and record.exc_info[1] is not None:
            line += f" error={record.exc_info[1]}"
        return line


_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message", "asctime", "taskName",
    # uvicorn attaches an ANSI-coloured copy of its own message. Harmless in a
    # terminal and noise in a log file, where it doubles every startup line and
    # carries escape sequences into whatever reads it.
    "color_message",
}


def configure() -> None:
    """Install the formatter on the root handler. Idempotent."""
    fmt = os.getenv("LOG_FORMAT", "json").lower()
    level = os.getenv("LOG_LEVEL", "info").upper()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter() if fmt != "text" else _TextFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(getattr(logging, level, logging.INFO))

    # uvicorn installs its own handlers and sets propagate=False, so its lines
    # would bypass everything above and print a second, unstructured copy of an
    # event the middleware already records — with no request id and no
    # duration. Routed here instead; the access logger is silenced because
    # `http.request` replaces it, rather than duplicating it.
    for name in ("uvicorn", "uvicorn.error"):
        uv = logging.getLogger(name)
        uv.handlers = [handler]
        uv.propagate = False
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False
