"""
database.py
-----------
SQLite persistence for the Sign-to-Text translation history.

The database file is created automatically in the same directory as this
module the first time the application runs.  All queries use parameterized
statements to prevent SQL-injection.

Public API
----------
init_db()                         → create the table if it doesn't exist
save_translation(gesture: str)    → insert one row; return its new row id
get_history(after_id: int = 0)    → list of dicts [{id, gesture, timestamp}]
clear_history()                   → delete all rows
"""

import os
import sqlite3

# Database file lives beside this script
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "history.db")


def _connect():
    """Open a connection with row_factory so rows come back as dicts."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row   # lets us do row["column_name"]
    return conn


def init_db():
    """
    Create the translations table if it does not already exist.
    Called once when app.py starts.
    """
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS translations (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                gesture   TEXT    NOT NULL,
                timestamp TEXT    NOT NULL
                          DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
            )
        """)
        conn.commit()


def save_translation(gesture: str) -> int:
    """
    Insert a new translation row.
    Returns the new row's integer id.
    """
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO translations (gesture) VALUES (?)",
            (gesture,)          # parameterized — never string-interpolated
        )
        conn.commit()
        return cursor.lastrowid


def get_history(after_id: int = 0) -> list[dict]:
    """
    Return all translations with id > after_id, oldest first.
    Pass after_id=0 to fetch the full history.
    Each element is a plain dict: {"id": int, "gesture": str, "timestamp": str}
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, gesture, timestamp FROM translations "
            "WHERE id > ? ORDER BY id ASC",
            (after_id,)
        ).fetchall()
    # Convert sqlite3.Row objects to plain dicts for JSON serialisation
    return [{"id": row["id"],
             "gesture": row["gesture"],
             "timestamp": row["timestamp"]} for row in rows]


def clear_history() -> int:
    """
    Delete all rows from the translations table.
    Returns the number of rows deleted.
    """
    with _connect() as conn:
        cursor = conn.execute("DELETE FROM translations")
        conn.commit()
        return cursor.rowcount
