-- ============================================================================
--  Registers dAttendance inside dAdmin. Run AFTER 001.
--  Without this the navbar, the AccessGate and the app kill-switch all
--  fail closed and nobody - including you - can open the new pages.
-- ============================================================================
USE `dadmin`;

-- 1. Per-employee app kill switch. Mirrors app_dTime, app_dSlip, etc.
--    Default 1: everyone fills their own attendance.
ALTER TABLE `employee`
  ADD COLUMN `app_dAttendance` TINYINT(1) NOT NULL DEFAULT 1 AFTER `app_dNews`;

-- 2. Inside D / maintenance visibility.
INSERT INTO `app_visibility` (`app_name`, `mode`, `updated_by`, `maintenance`)
VALUES ('dAttendance', 'employees', 'DZIND002', 0)
ON DUPLICATE KEY UPDATE `mode` = VALUES(`mode`);

-- 3. Access matrix rows. display_order 50+ avoids the existing collision at 27
--    (dTime 'Timesheet Approvals' and dSlip 'Payslip Management' share it).
INSERT INTO `access_levels`
  (`category`, `page_name`, `admin_access`, `subadmin_access`, `manager_access`, `user_access`, `created_by`, `display_order`)
VALUES
  ('dAttendance', 'Work Pattern',     1, 1, 0, 0, 'DZIND002', 50),
  ('dAttendance', 'Reminders',        1, 1, 0, 0, 'DZIND002', 51),
  ('dAttendance', 'Approvals',        1, 1, 1, 0, 'DZIND002', 52),
  ('dAttendance', 'Activity History', 1, 1, 0, 0, 'DZIND002', 53),
  ('dAttendance', 'User Interface',   1, 1, 1, 1, 'DZIND002', 54);
