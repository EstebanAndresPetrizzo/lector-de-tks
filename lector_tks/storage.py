from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


FIELDS = ("date", "amount", "cuit", "invoice", "concept")


class RecordStore:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self.connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT NOT NULL DEFAULT '',
                    amount REAL,
                    cuit TEXT NOT NULL DEFAULT '',
                    invoice TEXT NOT NULL DEFAULT '',
                    concept TEXT NOT NULL DEFAULT '',
                    source_file TEXT NOT NULL DEFAULT '',
                    page_number INTEGER NOT NULL DEFAULT 1,
                    extraction_method TEXT NOT NULL DEFAULT 'ocr',
                    confidence INTEGER NOT NULL DEFAULT 0,
                    warnings TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'review',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
                CREATE INDEX IF NOT EXISTS idx_records_identity ON records(cuit, invoice);

                CREATE TABLE IF NOT EXISTS concept_rules (
                    cuit TEXT PRIMARY KEY,
                    concept TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )

    @staticmethod
    def _row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["warnings"] = [item for item in result["warnings"].split("|") if item]
        return result

    def list_records(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM records ORDER BY created_at DESC, id DESC"
            ).fetchall()
        return [self._row(row) for row in rows]

    def get_record(self, record_id: int) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM records WHERE id = ?", (record_id,)
            ).fetchone()
        return self._row(row) if row else None

    def find_duplicate(self, cuit: str, invoice: str) -> dict[str, Any] | None:
        if not cuit or not invoice:
            return None
        with self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM records WHERE cuit = ? AND invoice = ? LIMIT 1",
                (cuit, invoice),
            ).fetchone()
        return self._row(row) if row else None

    def add_record(self, record: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        duplicate = self.find_duplicate(record.get("cuit", ""), record.get("invoice", ""))
        if duplicate:
            return duplicate, True

        now = datetime.now(timezone.utc).isoformat()
        with self.connection() as connection:
            cursor = connection.execute(
                """
                INSERT INTO records (
                    date, amount, cuit, invoice, concept, source_file, page_number,
                    extraction_method, confidence, warnings, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.get("date", ""),
                    record.get("amount"),
                    record.get("cuit", ""),
                    record.get("invoice", ""),
                    record.get("concept", ""),
                    record.get("source_file", ""),
                    int(record.get("page_number", 1)),
                    record.get("extraction_method", "ocr"),
                    int(record.get("confidence", 0)),
                    "|".join(record.get("warnings", [])),
                    record.get("status", "review"),
                    now,
                    now,
                ),
            )
            record_id = int(cursor.lastrowid)
        return self.get_record(record_id), False

    def update_record(self, record_id: int, values: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {key: values[key] for key in FIELDS if key in values}
        if "status" in values:
            allowed["status"] = values["status"]
        if not allowed:
            return self.get_record(record_id)

        if values.get("learn_concept") and allowed.get("cuit") and allowed.get("concept"):
            self.set_concept_rule(str(allowed["cuit"]), str(allowed["concept"]))

        allowed["updated_at"] = datetime.now(timezone.utc).isoformat()
        assignments = ", ".join(f"{column} = ?" for column in allowed)
        with self.connection() as connection:
            connection.execute(
                f"UPDATE records SET {assignments} WHERE id = ?",
                (*allowed.values(), record_id),
            )
        return self.get_record(record_id)

    def delete_record(self, record_id: int) -> bool:
        with self.connection() as connection:
            cursor = connection.execute("DELETE FROM records WHERE id = ?", (record_id,))
        return cursor.rowcount > 0

    def clear_records(self) -> int:
        with self.connection() as connection:
            cursor = connection.execute("DELETE FROM records")
        return cursor.rowcount

    def set_concept_rule(self, cuit: str, concept: str) -> None:
        cuit = "".join(character for character in cuit if character.isdigit())
        if len(cuit) != 11 or not concept.strip():
            return
        now = datetime.now(timezone.utc).isoformat()
        with self.connection() as connection:
            connection.execute(
                """
                INSERT INTO concept_rules (cuit, concept, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(cuit) DO UPDATE SET concept = excluded.concept, updated_at = excluded.updated_at
                """,
                (cuit, concept.strip(), now),
            )

    def concept_for_cuit(self, cuit: str) -> str | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT concept FROM concept_rules WHERE cuit = ?", (cuit,)
            ).fetchone()
        return str(row["concept"]) if row else None
