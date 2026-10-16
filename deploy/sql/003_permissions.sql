-- Per-user permissions (keys from PERMISSIONS in src/shared/contract.ts), as a
-- JSON array. NULL = the role's default set. Always cut down to the role's
-- ceiling when read, so a hand edit in phpMyAdmin cannot grant more than the role allows.
-- Idempotent: MySQL 8.4 has no ADD COLUMN IF NOT EXISTS, so check information_schema.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'permissions');
SET @sql := IF(@has = 0, 'ALTER TABLE users ADD COLUMN permissions JSON NULL AFTER role', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
