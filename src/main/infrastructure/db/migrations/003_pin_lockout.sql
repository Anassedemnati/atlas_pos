-- Users (Task 10 review): the till PIN and the back office password each get their own failure
-- counter and lock. Until now they shared `failed_logins` / `locked_until`; those two columns now
-- belong to the back office password door, and a lock on one door no longer stops the other (a LAN
-- client guessing a manager's web password must not lock the manager out of the till).

ALTER TABLE users ADD COLUMN pin_failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pin_locked_until TEXT;
