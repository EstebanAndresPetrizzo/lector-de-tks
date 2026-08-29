from __future__ import annotations

import json
import os
import re
import secrets
import socket
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from lector_tks.excel_export import build_workbook
from lector_tks.extractor import DEFAULT_CONCEPT, extract_records, ocr_available, parse_data_url
from lector_tks.storage import RecordStore


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "web"
DATA_DIR = Path(os.environ.get("LECTOR_TKS_DATA", ROOT / "data"))
HOST = os.environ.get("LECTOR_TKS_HOST", "0.0.0.0")
PORT = int(os.environ.get("LECTOR_TKS_PORT", "4173"))
ACCESS_PIN = os.environ.get("LECTOR_TKS_PIN") or f"{secrets.randbelow(1_000_000):06d}"
MAX_BODY = 42 * 1024 * 1024
STORE = RecordStore(DATA_DIR / "registros.sqlite3")


MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


def local_addresses() -> list[str]:
    addresses: set[str] = set()
    try:
        host_name = socket.gethostname()
        addresses.update(socket.gethostbyname_ex(host_name)[2])
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            addresses.add(probe.getsockname()[0])
    except OSError:
        pass
    return sorted(address for address in addresses if not address.startswith("127."))


def valid_record(record: dict[str, Any]) -> bool:
    return bool(
        re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(record.get("date", "")))
        and isinstance(record.get("amount"), (int, float))
        and float(record["amount"]) > 0
        and re.fullmatch(r"\d{11}", str(record.get("cuit", "")))
        and re.fullmatch(r"\d{9,20}", str(record.get("invoice", "")))
        and str(record.get("concept", "")).strip()
    )


class ApplicationHandler(BaseHTTPRequestHandler):
    server_version = "LectorTKS/2.0"

    def log_message(self, message: str, *args: Any) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {message % args}\n")

    def _send(self, status: int, body: bytes = b"", content_type: str = "text/plain; charset=utf-8", **headers: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in headers.items():
            self.send_header(key.replace("_", "-"), value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(
            status,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Longitud de solicitud inválida.") from error
        if length <= 0 or length > MAX_BODY:
            raise ValueError("El archivo está vacío o supera el máximo de 40 MB.")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("La solicitud no contiene JSON válido.") from error
        if not isinstance(payload, dict):
            raise ValueError("La solicitud debe ser un objeto JSON.")
        return payload

    def _authorized(self, parsed_url=None) -> bool:
        parsed_url = parsed_url or urlparse(self.path)
        query_pin = parse_qs(parsed_url.query).get("pin", [""])[0]
        supplied = self.headers.get("X-Access-Pin", "") or query_pin
        return secrets.compare_digest(str(supplied), ACCESS_PIN)

    def _require_authorized(self, parsed_url=None) -> bool:
        if self._authorized(parsed_url):
            return True
        self._json(HTTPStatus.UNAUTHORIZED, {"error": "PIN incorrecto o ausente."})
        return False

    def _serve_static(self, parsed_url) -> None:
        relative = "index.html" if parsed_url.path == "/" else parsed_url.path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if not target.is_relative_to(STATIC_DIR.resolve()):
            self._send(HTTPStatus.FORBIDDEN, b"No autorizado")
            return
        try:
            content = target.read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            self._send(HTTPStatus.NOT_FOUND, b"No encontrado")
            return
        self._send(HTTPStatus.OK, content, MIME_TYPES.get(target.suffix.lower(), "application/octet-stream"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        if parsed.path.startswith("/api/") and not self._require_authorized(parsed):
            return
        if parsed.path == "/api/info":
            self._json(
                HTTPStatus.OK,
                {
                    "ocr_available": ocr_available(),
                    "addresses": [f"http://{address}:{PORT}/?pin={ACCESS_PIN}" for address in local_addresses()],
                    "default_concept": DEFAULT_CONCEPT,
                },
            )
            return
        if parsed.path == "/api/records":
            records = STORE.list_records()
            self._json(HTTPStatus.OK, {"records": records})
            return
        self._serve_static(parsed)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not self._require_authorized(parsed):
            return
        try:
            if parsed.path == "/api/upload":
                payload = self._read_json()
                file_name = Path(str(payload.get("name", "comprobante"))).name
                encoded = payload.get("data")
                if not isinstance(encoded, str):
                    raise ValueError("Falta el contenido del archivo.")
                content = parse_data_url(encoded)
                default_concept = str(payload.get("default_concept") or DEFAULT_CONCEPT).strip()
                extracted = extract_records(file_name, content, default_concept, STORE.concept_for_cuit)
                created = []
                duplicates = []
                for record in extracted:
                    saved, duplicate = STORE.add_record(record)
                    (duplicates if duplicate else created).append(saved)
                self._json(
                    HTTPStatus.CREATED,
                    {"created": created, "duplicates": duplicates, "file_name": file_name},
                )
                return

            if parsed.path == "/api/export":
                payload = self._read_json()
                selected_ids = {int(item) for item in payload.get("ids", []) if str(item).isdigit()}
                all_records = STORE.list_records()
                records = [record for record in all_records if not selected_ids or record["id"] in selected_ids]
                if not records:
                    raise ValueError("Todavía no hay registros para exportar.")
                invalid = [record["id"] for record in records if not valid_record(record)]
                if invalid:
                    raise ValueError(f"Revisá los registros incompletos antes de exportar: {invalid}")
                workbook = build_workbook(sorted(records, key=lambda item: (item["date"], item["id"])))
                period = re.sub(r"[^0-9-]", "", str(payload.get("period", ""))) or "registro"
                self._send(
                    HTTPStatus.OK,
                    workbook,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    Content_Disposition=f'attachment; filename="Registro Deducciones {period}.xlsx"',
                )
                return

            if parsed.path == "/api/records/clear":
                deleted = STORE.clear_records()
                self._json(HTTPStatus.OK, {"deleted": deleted})
                return

            self._json(HTTPStatus.NOT_FOUND, {"error": "Ruta no encontrada."})
        except Exception as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error) or "No se pudo completar la operación."})

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        if not self._require_authorized(parsed):
            return
        match = re.fullmatch(r"/api/records/(\d+)", parsed.path)
        if not match:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Registro no encontrado."})
            return
        try:
            payload = self._read_json()
            record = STORE.update_record(int(match.group(1)), payload)
            if record is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "Registro no encontrado."})
                return
            self._json(HTTPStatus.OK, {"record": record})
        except Exception as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if not self._require_authorized(parsed):
            return
        match = re.fullmatch(r"/api/records/(\d+)", parsed.path)
        if not match:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Registro no encontrado."})
            return
        deleted = STORE.delete_record(int(match.group(1)))
        self._json(HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND, {"deleted": deleted})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), ApplicationHandler)
    local_url = f"http://127.0.0.1:{PORT}/?pin={ACCESS_PIN}"
    print("\nLector de comprobantes listo.")
    print(f"PC:      {local_url}")
    for address in local_addresses():
        print(f"Celular: http://{address}:{PORT}/?pin={ACCESS_PIN}")
    print(f"PIN:     {ACCESS_PIN}")
    print("Los datos quedan guardados únicamente en esta computadora.\n")
    if os.environ.get("LECTOR_TKS_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(local_url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLector detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
