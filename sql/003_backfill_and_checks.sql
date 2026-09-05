-- ============================================================================
--  Optional. Backfill + data-quality checks. Read each block before running.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. dtime.holidays data quality. Run these FIRST - dAttendance's working-day
--    count is only as good as this table.
-- ---------------------------------------------------------------------------

-- A1. Rows whose scope value cannot resolve. holiday_id 8 in the current dump
--     is holiday_for='job_position' with holiday_value='Chennai' - a location
--     value in a job-position field. It matches nobody and never will.
SELECT h.holiday_id, h.holiday_date, h.holiday_name, h.holiday_for, h.holiday_value
  FROM dtime.holidays h
 WHERE (h.holiday_for = 'job_position'
        AND NOT EXISTS (SELECT 1 FROM dadmin.job_position_config j
                         WHERE FIND_IN_SET(j.job_id, h.holiday_value)))
    OR (h.holiday_for = 'department' AND h.holiday_value <> 'All'
        AND NOT EXISTS (SELECT 1 FROM dadmin.department_config d
                         WHERE FIND_IN_SET(d.department_id, h.holiday_value)))
    OR (h.holiday_for = 'employee'
        AND NOT EXISTS (SELECT 1 FROM dadmin.employee e
                         WHERE FIND_IN_SET(e.emp_id COLLATE utf8mb4_unicode_ci, h.holiday_value)));

-- A2. Which years actually have holidays. Any year the employee app can reach
--     that returns 0 rows will count every weekday as a working day.
SELECT YEAR(holiday_date) AS yr, COUNT(*) AS rows_
  FROM dtime.holidays GROUP BY yr ORDER BY yr;

-- ---------------------------------------------------------------------------
-- B. Default every active employee to MON_FRI for a year, so the work pattern
--    page has explicit rows rather than relying on the implicit default.
--    Change @yr, then run. Safe to re-run.
-- ---------------------------------------------------------------------------
SET @yr := 2026;

INSERT IGNORE INTO dattendance.att_work_pattern (emp_id, year, month, pattern, created_by)
SELECT e.emp_id COLLATE utf8mb4_unicode_ci, @yr, m.n, 'MON_FRI', 'SYSTEM'
  FROM dadmin.employee e
  JOIN (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6
        UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12) m
 WHERE e.active = 1 AND e.deleted_time IS NULL;

-- ---------------------------------------------------------------------------
-- C. Sanity: emp_id width. dadmin uses VARCHAR(20); dtime.leave_requests uses
--    VARCHAR(45) and still holds legacy ids like 'dAssist-2025-00001' (18).
--    If this returns rows, dattendance's VARCHAR(20) is too narrow.
-- ---------------------------------------------------------------------------
SELECT emp_id, CHAR_LENGTH(emp_id) AS len FROM dadmin.employee WHERE CHAR_LENGTH(emp_id) > 20;
