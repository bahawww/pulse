-- Pulse login accounts. Applied at every server start; must stay idempotent.
-- password_hash format: scrypt$N$r$p$<salt b64url>$<hash b64url> (src/server/users.ts).
-- phpMyAdmin cannot make that hash: set passwords with `node scripts/user.mjs passwd <name>`
-- or the Users view.
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
