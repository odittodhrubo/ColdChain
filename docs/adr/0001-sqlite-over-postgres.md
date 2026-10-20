# 0001 — SQLite over PostgreSQL

## Status

Accepted.

## Context

ColdChain monitors the fridges of a single pharmacy: two to a few dozen nodes, each sending one reading every five seconds. The write rate is low (a few rows per second at most), the read rate is a handful of dashboard clients, and the whole dataset for a year is well under the size at which a single machine struggles. The deployment target is a clinic with no database administrator and, often, no reliable internet. Whatever we choose has to survive a power cut and start again without anyone logging in.

A client-server database such as PostgreSQL would bring connection pooling, concurrent writers and network access — none of which this workload needs, all of which add a second process to install, secure, back up and keep running.

## Decision

Use SQLite in WAL (write-ahead logging) mode, one file on disk, accessed in-process through `better-sqlite3`. Every query is parameterised. Schema changes ship as numbered, append-only migration files in `backend/src/db/migrations/`; an applied migration is never edited.

## Consequences

- No separate database process to run, secure or monitor. The backend opens a file.
- WAL mode lets the dashboard read while the ingestor writes, which is the only concurrency this system has.
- Online backups are a file copy taken while the app writes (see R7, `BACKUP_DIR`); off-box retention is the deployment's job.
- The ceiling is one writer. This is correct for one pharmacy and proven under load (`make perf`: worst p95 ~51 ms with a flood and 24 h of history). It is the wrong choice for many sites writing to one central server; that scenario — and only that — is the reason to revisit this and move to PostgreSQL.
- Retention and hourly rollups (R8) keep the `readings` table from growing without bound (~17 280 rows per fridge per day).
