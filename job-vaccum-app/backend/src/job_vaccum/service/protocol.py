import json
from typing import BinaryIO, Iterator

MAX_MESSAGE_BYTES = 1024 * 1024


class CommandError(Exception):
    def __init__(self, message: str, code: str = "VALIDATION_ERROR"):
        super().__init__(message)
        self.code = code


def lines(stream: BinaryIO) -> Iterator[bytes | None]:
    """Bound memory and discard the rest of an oversized line before continuing."""
    while chunk := stream.readline(MAX_MESSAGE_BYTES + 2):
        if len(chunk.removesuffix(b"\n")) > MAX_MESSAGE_BYTES:
            while not chunk.endswith(b"\n"):
                chunk = stream.readline(MAX_MESSAGE_BYTES + 2)
                if not chunk:
                    break
            yield None
        else:
            yield chunk


def reject_constant(_: str):
    raise ValueError("Non-finite JSON numbers are not allowed")


def decode(line: bytes | None) -> tuple[str, str, dict]:
    if line is None:
        raise CommandError("Message exceeds the 1 MiB limit.")
    try:
        request = json.loads(line.decode("utf-8"), parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise CommandError("Expected a UTF-8 JSON object.") from exc
    if not isinstance(request, dict):
        raise CommandError("Request must be an object.")
    request_id = request.get("id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise CommandError("Request id must contain 1 to 128 characters.")
    # The caller can correlate errors after a valid id has been decoded.
    return request_id, request.get("method"), request


def validate(request: dict) -> dict:
    if set(request) - {"type", "id", "method", "params"}:
        raise CommandError("Unexpected request fields.")
    if request.get("type") != "request":
        raise CommandError("Request type must be 'request'.")
    if not isinstance(request.get("method"), str) or not request["method"]:
        raise CommandError("Request method must be a non-empty string.")
    params = request.get("params", {})
    if not isinstance(params, dict):
        raise CommandError("Request params must be an object.")
    return params


def write(stream: BinaryIO, message: dict) -> None:
    stream.write(json.dumps(message, ensure_ascii=True, allow_nan=False,
                            separators=(",", ":")).encode("utf-8") + b"\n")
    stream.flush()
