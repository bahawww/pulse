-- One permanent superadmin (the env ADMIN_USER). The app refuses to delete,
-- disable, demote or rename it, and restores it at every start
-- (ensureSuperadmin in src/server/users.ts). Idempotent.
ALTER TABLE users MODIFY role ENUM('superadmin','admin','operator','viewer') NOT NULL DEFAULT 'viewer';
