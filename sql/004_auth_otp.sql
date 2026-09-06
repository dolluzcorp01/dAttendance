-- ============================================================================
--  dAttendance - two-factor sign-in and password reset.
--  Run AFTER 001. Touches only the `dattendance` database.
--
--  WHY NOT dadmin.otpstorage
--  -------------------------
--  dAdmin's existing `otpstorage` table stores the OTP in PLAIN TEXT, keyed by
--  email, with no attempt counter and no emp_id. Anyone who can read that table
--  or a dump of it can complete a password reset for any address in it. These
--  tables follow dEpr's pattern instead: the OTP is bcrypt-hashed before it is
--  stored, attempts are counted and capped, and a used code is consumed so it
--  cannot be replayed.
-- ============================================================================
USE `dattendance`;

-- ---------------------------------------------------------------------------
-- 1. One row per issued code.
--
--    purpose 'login' - second factor after a correct password
--    purpose 'reset' - proving ownership of the mailbox before a new password
--
--    The row is never handed to the client. The client holds a signed
--    challenge token that names this row, so otp_id is not enumerable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_otp` (
  `otp_id`        INT NOT NULL AUTO_INCREMENT,
  `emp_id`        VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `purpose`       ENUM('login','reset') NOT NULL,
  `otp_hash`      VARCHAR(255) NOT NULL COMMENT 'bcrypt - never the code itself',
  `expires_at`    DATETIME NOT NULL,
  `attempts`      TINYINT NOT NULL DEFAULT 0,
  `consumed_time` DATETIME DEFAULT NULL COMMENT 'set on success so a code works once',
  `reset_spent_time` DATETIME DEFAULT NULL
                  COMMENT 'reset only: the token minted from this code has been used',
  `ip_address`    VARCHAR(64) DEFAULT NULL,
  `created_time`  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`otp_id`),
  KEY `idx_otp_emp` (`emp_id`,`purpose`,`created_time`),
  KEY `idx_otp_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. "Remember for 14 days" - one row per browser the employee has trusted.
--
--    The cookie holds a 32-byte random token; only its SHA-256 is stored here,
--    so a leaked dump cannot be replayed as a device. Trust is per browser, not
--    per account: signing in from a new machine still needs a code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_trusted_device` (
  `device_id`      INT NOT NULL AUTO_INCREMENT,
  `emp_id`         VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash`     CHAR(64) NOT NULL COMMENT 'sha256 hex of the cookie value',
  `expires_at`     DATETIME NOT NULL,
  `user_agent`     VARCHAR(255) DEFAULT NULL,
  `ip_address`     VARCHAR(64) DEFAULT NULL,
  `created_time`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  `last_used_time` DATETIME DEFAULT NULL,
  `revoked_time`   DATETIME DEFAULT NULL,
  PRIMARY KEY (`device_id`),
  UNIQUE KEY `uq_device_token` (`token_hash`),
  KEY `idx_device_emp` (`emp_id`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Configuration, alongside the existing attendance keys.
-- ---------------------------------------------------------------------------
INSERT INTO `att_config` (`config_key`, `config_value`, `description`) VALUES
  ('otp_expiry_minutes',  '2',  'How long a sign-in or reset code stays valid'),
  ('otp_max_attempts',    '5',  'Wrong guesses allowed against one code before it dies'),
  ('otp_resend_seconds',  '30', 'Minimum gap between two sends to the same person'),
  ('otp_max_per_hour',    '6',  'Codes one employee may request per hour'),
  ('trusted_device_days', '14', 'How long "Remember for 14 days" skips the code')
ON DUPLICATE KEY UPDATE `config_value` = VALUES(`config_value`);

-- ---------------------------------------------------------------------------
-- 4. Housekeeping. Expired codes are dead weight; run this from cron, or
--    just occasionally. Trusted devices are kept until they expire so the
--    employee can see and revoke them later.
-- ---------------------------------------------------------------------------
-- DELETE FROM att_otp WHERE expires_at < NOW() - INTERVAL 1 DAY;
-- DELETE FROM att_trusted_device WHERE expires_at < NOW() - INTERVAL 30 DAY;
