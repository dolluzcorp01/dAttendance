-- ============================================================================
--  dAttendance - schema
--  Target: MySQL 8, new database `dattendance`
--
--  COLLATION NOTE (important):
--  dadmin.employee.emp_id is utf8mb4_unicode_ci. Every emp_id column below
--  uses the SAME collation so cross-database joins to dadmin.employee do not
--  throw "Illegal mix of collations". dtime.holidays.holiday_value is
--  utf8mb4_0900_ai_ci, which is why the calendar queries still COLLATE cast.
--
--  emp_id is VARCHAR(20) (e.g. 'DZIND147'). It is NEVER an integer - any
--  Number() coercion in JS, or an INT column here, is a bug.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `dattendance`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `dattendance`;

-- ---------------------------------------------------------------------------
-- 1. Runtime configuration. No business rule is hardcoded in JS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_config` (
  `config_key`    VARCHAR(60)  NOT NULL,
  `config_value`  VARCHAR(255) NOT NULL,
  `description`   VARCHAR(255) DEFAULT NULL,
  `updated_by`    VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_time`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `att_config` (`config_key`, `config_value`, `description`) VALUES
  ('allowed_leave_per_month', '2',      'Leave days per month before Loss of Pay begins'),
  ('edit_request_limit',      '2',      'Edit requests an employee may raise per month'),
  -- These are the days the nudge GOES OUT, not the deadline it quotes. Both
  -- mails cite the employee's last working day of the month as the due date.
  ('reminder_1_day',          '21',     'Day of month reminder 1 is sent'),
  ('reminder_2_day',          '24',     'Day of month reminder 2 is sent'),
  ('fill_forward_from_day',   '24',     'From this day the employee may fill the rest of the month'),
  ('leave_source',            'manual', 'manual = employee marks L | dtime = read approved leave_requests'),
  ('min_year',                '2018',   'Earliest year selectable in the year dropdown')
ON DUPLICATE KEY UPDATE `config_value` = VALUES(`config_value`);

-- ---------------------------------------------------------------------------
-- 2. Work pattern - set per employee PER MONTH from dAdmin.
--    MON_FRI    Sat + Sun are week-offs                        (default)
--    MON_SAT    only Sun is a week-off
--    MON_ADHOC  MON_FRI base, plus specific days forced to working
--               (att_adhoc_day) - those override week-offs AND holidays
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_work_pattern` (
  `pattern_id`   INT NOT NULL AUTO_INCREMENT,
  `emp_id`       VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `year`         SMALLINT NOT NULL,
  `month`        TINYINT  NOT NULL COMMENT '1-12',
  `pattern`      ENUM('MON_FRI','MON_SAT','MON_ADHOC') NOT NULL DEFAULT 'MON_FRI',
  `created_by`   VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_by`   VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_time` DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`pattern_id`),
  UNIQUE KEY `uq_pattern_emp_month` (`emp_id`,`year`,`month`),
  KEY `idx_pattern_month` (`year`,`month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `att_adhoc_day` (
  `adhoc_id`     INT NOT NULL AUTO_INCREMENT,
  `emp_id`       VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `work_date`    DATE NOT NULL,
  `note`         VARCHAR(255) DEFAULT NULL,
  `created_by`   VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`adhoc_id`),
  UNIQUE KEY `uq_adhoc_emp_date` (`emp_id`,`work_date`),
  KEY `idx_adhoc_date` (`work_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. The sheet - one row per employee per month.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_sheet` (
  `sheet_id`            INT NOT NULL AUTO_INCREMENT,
  `emp_id`              VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `year`                SMALLINT NOT NULL,
  `month`               TINYINT  NOT NULL COMMENT '1-12',
  `status`              ENUM('draft','saved','submitted','edit_requested','edit_open','approved','rejected')
                        NOT NULL DEFAULT 'draft',
  `edit_requests_used`  TINYINT NOT NULL DEFAULT 0,
  `approver_id`         VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL
                        COMMENT 'resolved at submit: reporting_manager, else admin',
  `submitted_time`      DATETIME DEFAULT NULL,
  `decided_by`          VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `decided_time`        DATETIME DEFAULT NULL,
  `created_time`        DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_time`        DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`sheet_id`),
  UNIQUE KEY `uq_sheet_emp_month` (`emp_id`,`year`,`month`),
  KEY `idx_sheet_status` (`status`),
  KEY `idx_sheet_month` (`year`,`month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- day_type is the RESOLVED calendar verdict at save time, stored so a later
-- holiday edit cannot silently rewrite a month that has already been paid.
CREATE TABLE IF NOT EXISTS `att_sheet_day` (
  `day_id`       INT NOT NULL AUTO_INCREMENT,
  `sheet_id`     INT NOT NULL,
  `work_date`    DATE NOT NULL,
  `day_status`   ENUM('P','L','H') NOT NULL,
  `day_type`     ENUM('WORK','WEEKOFF','HOLIDAY','NON_EMPLOYED') NOT NULL,
  `source`       ENUM('employee','system','dtime_leave') NOT NULL DEFAULT 'employee',
  `note`         VARCHAR(255) DEFAULT NULL,
  `updated_time` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`day_id`),
  UNIQUE KEY `uq_day_sheet_date` (`sheet_id`,`work_date`),
  CONSTRAINT `fk_day_sheet` FOREIGN KEY (`sheet_id`)
      REFERENCES `att_sheet` (`sheet_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Requests raised from the employee app, decided in dAdmin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_request` (
  `request_id`    INT NOT NULL AUTO_INCREMENT,
  `sheet_id`      INT NOT NULL,
  `request_type`  ENUM('approval','edit') NOT NULL,
  `status`        ENUM('pending','approved','accepted','rejected') NOT NULL DEFAULT 'pending',
  `reason`        VARCHAR(500) DEFAULT NULL,
  `raised_by`     VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `raised_time`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  `decided_by`    VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `decided_time`  DATETIME DEFAULT NULL,
  `decision_note` VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (`request_id`),
  KEY `idx_request_status` (`status`),
  KEY `idx_request_sheet` (`sheet_id`),
  CONSTRAINT `fk_request_sheet` FOREIGN KEY (`sheet_id`)
      REFERENCES `att_sheet` (`sheet_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. Reminders. Two only: R1 goes out on reminder_1_day, R2 on reminder_2_day.
--
--    Both quote the SAME deadline - the employee's last working day of that
--    month, which is when the sheet is actually due. That date differs per
--    employee because the work pattern does, so it is computed at send time and
--    stored here on the row, not derived from a config day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_reminder` (
  `reminder_id`  INT NOT NULL AUTO_INCREMENT,
  `emp_id`       VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `year`         SMALLINT NOT NULL,
  `month`        TINYINT  NOT NULL,
  `reminder_no`  TINYINT  NOT NULL COMMENT '1 | 2',
  `enabled`      TINYINT(1) NOT NULL DEFAULT 1,
  `due_date`     DATE DEFAULT NULL COMMENT 'the last working day quoted in the mail',
  `sent_time`    DATETIME DEFAULT NULL,
  `sent_by`      VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`reminder_id`),
  UNIQUE KEY `uq_reminder` (`emp_id`,`year`,`month`,`reminder_no`),
  KEY `idx_reminder_month` (`year`,`month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. Activity log - dAdmin page 4 renders this.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `att_activity` (
  `activity_id`  INT NOT NULL AUTO_INCREMENT,
  `emp_id`       VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `year`         SMALLINT DEFAULT NULL,
  `month`        TINYINT  DEFAULT NULL,
  `action`       ENUM('Saved','Submitted','Edit request','Downloaded',
                      'Approved','Rejected','Edit accepted','Reminder sent',
                      'Pattern changed') NOT NULL,
  `detail`       VARCHAR(500) DEFAULT NULL,
  `actor_id`     VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip_address`   VARCHAR(64) DEFAULT NULL,
  `created_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`activity_id`),
  KEY `idx_activity_emp` (`emp_id`,`created_time`),
  KEY `idx_activity_month` (`year`,`month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
