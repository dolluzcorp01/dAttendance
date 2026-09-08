-- ============================================================================
--  dAttendance - 005 - Weekend / holiday support requests
--
--  An employee who worked on a day the calendar calls off (a week-off or a
--  declared holiday) raises a claim from the H cell. An admin decides it in
--  dAdmin. On approval the day becomes a working day and is marked P.
--
--  HOW THE FLIP HAPPENS
--  --------------------
--  Nothing here invents a new kind of day. Approval inserts a row into the
--  existing att_adhoc_day, and attendanceCalendar.js already ranks adhoc above
--  both WEEKOFF and HOLIDAY, on ANY work pattern. So the day resolves to WORK
--  through the same path an admin-added adhoc day always took, and every total
--  that reads off the calendar - working_days, days_off, the Excel - follows
--  without a single extra branch.
--
--  RUN THIS AND THE dADMIN PATCH TOGETHER. See the warning at the bottom.
-- ============================================================================
USE `dattendance`;

-- ---------------------------------------------------------------------------
-- 1. att_request carries the new type.
--
--    Reusing this table rather than opening a second queue is deliberate: the
--    approver already works one pending list, the routing (approver_id frozen
--    on att_sheet) already exists, and the decision columns are already here.
--    A support claim is about one DATE rather than the whole month, which is
--    the only thing the table could not already say - hence work_date.
-- ---------------------------------------------------------------------------
ALTER TABLE `att_request`
  MODIFY COLUMN `request_type` ENUM('approval','edit','support') NOT NULL;

ALTER TABLE `att_request`
  ADD COLUMN `work_date` DATE DEFAULT NULL
      COMMENT 'support only: the off-day being claimed' AFTER `request_type`,
  ADD COLUMN `day_portion` ENUM('full','half') DEFAULT NULL
      COMMENT 'support only: how much of the day was worked' AFTER `work_date`;

-- Finding "is there already a live claim on this date" is the hot path.
ALTER TABLE `att_request`
  ADD KEY `idx_request_support` (`work_date`,`status`);

-- ---------------------------------------------------------------------------
-- 2. Provenance on the flipped day.
--
--    The day is written as P by the approval, not by the employee. Note that a
--    later /save re-labels it 'employee', because writeMarks() rebuilds every
--    row from the calendar and the day is a plain working day by then. That is
--    harmless - att_request is the durable record of why the day exists - but
--    it is why you cannot use this column to count support days.
-- ---------------------------------------------------------------------------
ALTER TABLE `att_sheet_day`
  MODIFY COLUMN `source` ENUM('employee','system','dtime_leave','support')
         NOT NULL DEFAULT 'employee';

-- ---------------------------------------------------------------------------
-- 3. The activity log gets the three new verbs.
-- ---------------------------------------------------------------------------
ALTER TABLE `att_activity`
  MODIFY COLUMN `action` ENUM('Saved','Submitted','Edit request','Downloaded',
                              'Approved','Rejected','Edit accepted','Reminder sent',
                              'Pattern changed','Support request','Support approved',
                              'Support rejected') NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Config.
--
--    A claim is a statement about a day that has already happened, so there is
--    a window rather than an open door: N days after the date. 0 turns the
--    limit off entirely.
-- ---------------------------------------------------------------------------
INSERT INTO `att_config` (`config_key`, `config_value`, `description`) VALUES
  ('support_request_enabled',  '1',  'Show the Record Weekend Support control on off-days'),
  ('support_request_days',    '45',  'Days after the off-day a claim may still be raised (0 = no limit)')
ON DUPLICATE KEY UPDATE `config_value` = VALUES(`config_value`);

-- ============================================================================
--  WARNING - DO NOT RUN THIS WITHOUT THE dADMIN PATCH
--
--  dAdmin's /api/dattendance/approvals/decide currently branches on
--  request_type with only two cases, and the second is an ELSE:
--
--      sheetStatus = request_type === 'approval'
--          ? (reject ? 'rejected' : 'approved')
--          : (reject ? 'submitted' : 'edit_open');   <-- a 'support' row lands here
--
--  So approving a support request on an unpatched dAdmin would set the WHOLE
--  MONTH to 'edit_open' - silently reopening a submitted sheet - and would not
--  create the adhoc day, so the P would never appear. Patch decide() first.
-- ============================================================================
