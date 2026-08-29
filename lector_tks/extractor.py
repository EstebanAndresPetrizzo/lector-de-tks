from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
from datetime import date
from io import BytesIO
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


DEFAULT_CONCEPT = "GASTOS DE RESPRESENTACION"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".jfif", ".png", ".webp", ".bmp", ".tif", ".tiff"}
PDF_SUFFIXES = {".pdf"}
ARCA_HOSTS = {"afip.gob.ar", "www.afip.gob.ar", "arca.gob.ar", "www.arca.gob.ar"}


def only_digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def normalize_text(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def parse_data_url(value: str) -> bytes:
    if "," in value:
        value = value.split(",", 1)[1]
    return base64.b64decode(value, validate=True)


def normalize_invoice(point_of_sale: Any, receipt_number: Any) -> str:
    point = only_digits(point_of_sale) or "0"
    number = only_digits(receipt_number) or "0"
    normalized_point = point if len(point) > 1 and point.startswith("0") else point.zfill(5)
    normalized_number = number if len(number) > 1 and number.startswith("0") else number.zfill(8)
    return f"{normalized_point}{normalized_number}"


def parse_fiscal_qr(raw_value: str) -> dict[str, Any] | None:
    try:
        parsed = urlparse(raw_value.strip())
        if parsed.hostname not in ARCA_HOSTS or parsed.path.rstrip("/").lower() != "/fe/qr":
            return None
        payload = parse_qs(parsed.query).get("p", [None])[0]
        if not payload:
            return None
        padded = payload.replace("-", "+").replace("_", "/")
        padded += "=" * (-len(padded) % 4)
        data = json.loads(base64.b64decode(padded).decode("utf-8"))
        result = {
            "date": str(data.get("fecha", "")),
            "amount": float(data["importe"]) if data.get("importe") is not None else None,
            "cuit": only_digits(data.get("cuit")),
            "invoice": normalize_invoice(data.get("ptoVta"), data.get("nroCmp")),
            "extraction_method": "qr",
        }
        if not valid_iso_date(result["date"]) or len(result["cuit"]) != 11:
            return None
        return result
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def valid_iso_date(value: str) -> bool:
    try:
        return date.fromisoformat(value).isoformat() == value
    except (TypeError, ValueError):
        return False


def _locate_tesseract() -> str | None:
    configured = os.environ.get("TESSERACT_CMD")
    candidates = [
        configured,
        shutil.which("tesseract"),
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    return next((candidate for candidate in candidates if candidate and Path(candidate).exists()), None)


def ocr_available() -> bool:
    return _locate_tesseract() is not None


def _prepare_for_ocr(image: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("L")
    if image.width < 1800:
        scale = min(3, max(2, round(1800 / max(image.width, 1))))
        image = image.resize((image.width * scale, image.height * scale), Image.Resampling.LANCZOS)
    image = ImageOps.autocontrast(image, cutoff=1)
    image = ImageEnhance.Contrast(image).enhance(1.35)
    return image.filter(ImageFilter.SHARPEN)


def run_ocr(image: Image.Image) -> str:
    executable = _locate_tesseract()
    if not executable:
        raise RuntimeError(
            "No encontré Tesseract OCR. Instalalo o configurá la variable TESSERACT_CMD."
        )

    prepared = _prepare_for_ocr(image)
    with tempfile.TemporaryDirectory(prefix="lector-tks-") as directory:
        image_path = Path(directory) / "ticket.png"
        prepared.save(image_path, format="PNG")
        languages = _available_languages(executable)
        language = "spa+eng" if "spa" in languages and "eng" in languages else ("spa" if "spa" in languages else "eng")
        result = subprocess.run(
            [executable, str(image_path), "stdout", "-l", language, "--psm", "6"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Tesseract no pudo leer el comprobante.")
    return result.stdout


def _available_languages(executable: str) -> set[str]:
    try:
        result = subprocess.run(
            [executable, "--list-langs"], capture_output=True, text=True, timeout=10, check=False
        )
        return {line.strip() for line in result.stdout.splitlines()[1:] if line.strip()}
    except (OSError, subprocess.SubprocessError):
        return {"eng"}


def _parse_amount(value: str) -> float | None:
    value = value.strip().replace("$", "").replace(" ", "")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?", value):
        value = value.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d+(?:,\d{1,2})?", value):
        value = value.replace(",", ".")
    elif re.fullmatch(r"\d+(?:\.\d{1,2})?", value):
        pass
    elif re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?", value):
        value = value.replace(",", "")
    else:
        return None
    try:
        amount = float(value)
        return round(amount, 2) if amount > 0 else None
    except ValueError:
        return None


def _extract_date(text: str) -> str:
    patterns = [
        r"(?:fecha(?:\s+de\s+emision)?|fec\.?)[^\d]{0,12}(\d{1,2})[\-/\.](\d{1,2})[\-/\.](\d{2,4})",
        r"\b(\d{1,2})[\-/\.](\d{1,2})[\-/\.](\d{4})\b",
        r"\b(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})\b",
    ]
    for index, pattern in enumerate(patterns):
        match = re.search(pattern, text, re.IGNORECASE)
        if not match:
            continue
        parts = [int(item) for item in match.groups()]
        if index == 2:
            year, month, day = parts
        else:
            day, month, year = parts
            year += 2000 if year < 100 else 0
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            continue
    return ""


def _extract_cuit(text: str) -> str:
    labeled = re.search(
        r"(?:cuit|c\.u\.i\.t\.?)[^\d]{0,10}(\d{2}\s*[-.]?\s*\d{8}\s*[-.]?\s*\d)",
        text,
        re.IGNORECASE,
    )
    if labeled:
        return only_digits(labeled.group(1))
    candidates = re.findall(r"(?<!\d)(\d{2}\s*[-.]?\s*\d{8}\s*[-.]?\s*\d)(?!\d)", text)
    return only_digits(candidates[0]) if candidates else ""


def _extract_amount(text: str) -> float | None:
    normalized = normalize_text(text)
    # El OCR suele separar los centavos: "94000 , 10" o "94000, 10".
    normalized = re.sub(r"(?<=\d)\s*([.,])\s*(?=\d)", r"\1", normalized)
    patterns = [
        r"(?:total\s+a\s+pagar|importe\s+total|total)[^\d]{0,15}(\d[\d.,]*\d|\d)",
        r"(?:importe|monto)[^\d]{0,15}(\d[\d.,]*\d|\d)",
    ]
    candidates: list[float] = []
    for pattern in patterns:
        for match in re.finditer(pattern, normalized, re.IGNORECASE):
            amount = _parse_amount(match.group(1))
            if amount is not None:
                candidates.append(amount)
        if candidates:
            return candidates[-1]
    return None


def _extract_invoice(text: str) -> str:
    patterns = [
        r"(?:punto|p\.?)\s*de\s+venta[^\d]{0,12}(\d{1,5}).{0,45}?(?:comp\.?|comprobante|nro\.?|n[°º])[^\d]{0,12}(\d{1,12})",
        r"(?:factura|ticket|tique|comprobante|nro\.?|n[°º])[^\d]{0,18}(\d{1,5})\s*[-/]\s*(\d{1,12})",
        r"(?<!\d)(\d{4,5})\s*[-/]\s*(\d{6,12})(?!\d)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
        if match:
            return normalize_invoice(match.group(1), match.group(2))
    return ""


def infer_concept(text: str, default_concept: str) -> str:
    normalized = normalize_text(text).lower()
    if re.search(r"farmacia|medicamento|drogueria|receta", normalized):
        return "FARMACIA"
    if re.search(r"cine|teatro|esparcimiento|entretenimiento|gimnasio|club", normalized):
        return "ESPARCIMIENTO"
    return default_concept.strip() or DEFAULT_CONCEPT


def parse_ocr_text(text: str, default_concept: str) -> dict[str, Any]:
    result = {
        "date": _extract_date(text),
        "amount": _extract_amount(text),
        "cuit": _extract_cuit(text),
        "invoice": _extract_invoice(text),
        "concept": infer_concept(text, default_concept),
        "extraction_method": "ocr",
    }
    return finalize_record(result)


def finalize_record(record: dict[str, Any]) -> dict[str, Any]:
    warnings: list[str] = []
    checks = {
        "date": (valid_iso_date(str(record.get("date", ""))), "No pude detectar una fecha válida."),
        "amount": (
            isinstance(record.get("amount"), (int, float)) and float(record["amount"]) > 0,
            "No pude detectar el importe total.",
        ),
        "cuit": (len(only_digits(record.get("cuit"))) == 11, "No pude detectar un CUIT de 11 dígitos."),
        "invoice": (len(only_digits(record.get("invoice"))) >= 9, "No pude detectar el número de comprobante."),
        "concept": (bool(str(record.get("concept", "")).strip()), "Falta asignar el concepto."),
    }
    for valid, message in checks.values():
        if not valid:
            warnings.append(message)
    record["cuit"] = only_digits(record.get("cuit"))
    record["invoice"] = only_digits(record.get("invoice"))
    record["confidence"] = round(100 * sum(1 for valid, _ in checks.values() if valid) / len(checks))
    record["warnings"] = warnings
    record["status"] = "ready" if not warnings else "review"
    return record


def _decode_qr(image: Image.Image) -> list[str]:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        return []

    array = cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)
    detector = cv2.QRCodeDetector()
    values: list[str] = []
    try:
        detected, decoded, _, _ = detector.detectAndDecodeMulti(array)
        if detected:
            values.extend(value for value in decoded if value)
    except (cv2.error, ValueError):
        pass
    if values:
        return values
    try:
        value, _, _ = detector.detectAndDecode(array)
        return [value] if value else []
    except cv2.error:
        return []


def _image_records(
    image: Image.Image,
    default_concept: str,
    concept_lookup: Callable[[str], str | None],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for raw_value in _decode_qr(image):
        qr_record = parse_fiscal_qr(raw_value)
        if qr_record:
            concept = concept_lookup(qr_record["cuit"]) or default_concept
            qr_record["concept"] = concept
            records.append(finalize_record(qr_record))
    if records:
        return records

    text = run_ocr(image)
    record = parse_ocr_text(text, default_concept)
    learned = concept_lookup(record["cuit"]) if record["cuit"] else None
    if learned:
        record["concept"] = learned
        record = finalize_record(record)
    return [record]


def extract_records(
    file_name: str,
    content: bytes,
    default_concept: str,
    concept_lookup: Callable[[str], str | None],
) -> list[dict[str, Any]]:
    suffix = Path(file_name).suffix.lower()
    pages: list[Image.Image]
    if suffix in PDF_SUFFIXES:
        try:
            import fitz  # type: ignore
        except ImportError as error:
            raise RuntimeError("Para procesar PDF falta instalar PyMuPDF.") from error
        document = fitz.open(stream=content, filetype="pdf")
        pages = []
        try:
            for page in document:
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2.2, 2.2), alpha=False)
                pages.append(Image.open(BytesIO(pixmap.tobytes("png"))).copy())
        finally:
            document.close()
    elif suffix in IMAGE_SUFFIXES:
        pages = [Image.open(BytesIO(content)).copy()]
    else:
        raise ValueError("Formato no admitido. Usá imágenes JPG/PNG/WEBP/TIFF o archivos PDF.")

    results: list[dict[str, Any]] = []
    for page_number, image in enumerate(pages, start=1):
        for record in _image_records(image, default_concept, concept_lookup):
            record["source_file"] = file_name
            record["page_number"] = page_number
            results.append(record)
    return results
