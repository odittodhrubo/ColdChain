-- P3: escalation. When an unacknowledged WARNING/CRITICAL alert has sat for ESCALATE_AFTER_S, it escalates once
-- (a second, flagged notification round). escalated_at marks it so escalation never repeats for the same episode.
ALTER TABLE alerts ADD COLUMN escalated_at INTEGER;
