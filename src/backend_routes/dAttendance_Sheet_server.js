// ============================================================================
//  dAttendance - the employee's own sheet.
//
//  Mount:  app.use("/api/sheet", SheetRoutes);
//
//  EVERY endpoint here operates on req.emp_id from the JWT. An emp_id in the
//  body or query is ignored on purpose - otherwise anyone could read or edit
//  a colleague's attendance by changing one parameter.
//
//  The edit window, the working-day count and the summary all come from
//  utils/attendanceCalendar.js. The frontend enforces the same rules for UX,
//  but the server is the authority: a disabled dropdown is not a control.
// ============================================================================
require("dotenv").config();
const express = require("express");
const router = express.Router();

const getDBConnection = require("../../config/db");
const { verifyJWT } = require("./Login_server");
const cal = require("./utils/attendanceCalendar");
const { buildAttendanceWorkbook, workbookFilename } = require("./utils/attendanceWorkbook");

const dadmin = getDBConnection("dadmin");
const datt = getDBConnection("dattendance");
const dtime = getDBConnection("dtime");

const q = (db, sql, params = []) =>
    new Promise((resolve, reject) =>
        db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

const todayYmd = () => {
    // Asia/Kolkata. The pool is set to +05:30; keep the app clock in the same
    // zone or a sheet saved late at night lands on the wrong day.
    const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return now.toISOString().slice(0, 10);
};

// NOT `Number(x) || fallback`. 0 is falsy, so a policy of "no free leave days"
// (allowed_leave_per_month = 0) would silently read back as 2 and under-report
// Loss of Pay on every payslip. Same for edit_request_limit = 0, which is how
// you turn edit requests off. Fall back only when the value is absent or not
// a number.
const num = (raw, fallback, min) => {
    const n = Number(raw);
    const v = (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) ? fallback : n;
    return min === undefined ? v : Math.max(min, v);
};

const loadConfig = async () => {
    const rows = await q(datt, `SELECT config_key, config_value FROM att_config`);
    const c = Object.fromEntries(rows.map((r) => [r.config_key, r.config_value]));
    return {
        allowedLeave: num(c.allowed_leave_per_month, 2, 0),
        editLimit: num(c.edit_request_limit, 2, 0),
        // A day outside 1-31 would put the fill-forward window nowhere.
        fillForwardFromDay: Math.min(31, num(c.fill_forward_from_day, 24, 1)),
        leaveSource: c.leave_source || "manual",
        minYear: num(c.min_year, 2018, 1970),
    };
};

const loadEmployee = async (emp_id) => {
    const rows = await q(dadmin, `
        SELECT emp_id, CONCAT_WS(' ', emp_first_name, emp_last_name) AS emp_name,
               emp_mail_id, emp_department, job_position, emp_location, reporting_manager,
               DATE_FORMAT(joining_date, '%Y-%m-%d') AS joining_date
          FROM employee
         WHERE emp_id = ? AND active = 1 AND deleted_time IS NULL
         LIMIT 1`, [emp_id]);
    return rows[0] || null;
};

// ---------------------------------------------------------------------------
// GET /years  - from the employee's joining year to the current year. Months
// before joining stay visible but locked, per the spec, so the year list is
// deliberately not trimmed to "months you can edit".
// ---------------------------------------------------------------------------
router.get("/years", verifyJWT, async (req, res) => {
    try {
        const emp = await loadEmployee(req.emp_id);
        if (!emp) return res.status(403).json({ error: "Account inactive" });
        const cfg = await loadConfig();
        const joinYear = emp.joining_date ? Number(emp.joining_date.slice(0, 4)) : cfg.minYear;
        const thisYear = Number(todayYmd().slice(0, 4));
        const years = [];
        for (let y = thisYear; y >= Math.max(joinYear, cfg.minYear); y--) years.push(y);
        res.json({ success: true, years, joining_date: emp.joining_date });
    } catch (err) {
        console.error("[sheet] /years", err);
        res.status(500).json({ error: "Database error" });
    }
});

// ---------------------------------------------------------------------------
// GET /month?year=&month=  - everything the sheet page needs, in one call.
// ---------------------------------------------------------------------------
router.get("/month", verifyJWT, async (req, res) => {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: "year and month (1-12) are required" });
    }

    try {
        const emp = await loadEmployee(req.emp_id);
        if (!emp) return res.status(403).json({ error: "Account inactive" });
        const cfg = await loadConfig();
        const today = todayYmd();

        const monthStart = cal.toYmd(year, month, 1);
        const monthEnd = cal.toYmd(year, month, cal.daysInMonth(year, month));

        const [patternRows, adhocRows, holidays, sheetRows] = await Promise.all([
            q(datt, `SELECT pattern FROM att_work_pattern WHERE emp_id = ? AND year = ? AND month = ?`,
              [req.emp_id, year, month]),
            q(datt, `SELECT DATE_FORMAT(work_date,'%Y-%m-%d') AS work_date
                       FROM att_adhoc_day WHERE emp_id = ? AND work_date BETWEEN ? AND ?`,
              [req.emp_id, monthStart, monthEnd]),
            q(dtime, `SELECT DATE_FORMAT(holiday_date,'%Y-%m-%d') AS holiday_date,
                             DATE_FORMAT(COALESCE(holiday_end, holiday_date),'%Y-%m-%d') AS holiday_end,
                             holiday_name, holiday_for, holiday_value
                        FROM holidays
                       WHERE holiday_date <= ? AND COALESCE(holiday_end, holiday_date) >= ?
                    ORDER BY holiday_date ASC`, [monthEnd, monthStart]),
            q(datt, `SELECT sheet_id, status, edit_requests_used, submitted_time
                       FROM att_sheet WHERE emp_id = ? AND year = ? AND month = ? LIMIT 1`,
              [req.emp_id, year, month]),
        ]);

        const pattern = patternRows[0]?.pattern || cal.DEFAULT_PATTERN;
        const calendar = cal.buildMonthCalendar({
            employee: emp, year, month, pattern,
            adhocDays: adhocRows.map((a) => a.work_date), holidays,
        });

        const sheet = sheetRows[0] || null;
        const sheetStatus = sheet?.status || "not_started";

        // Saved marks
        let marks = {};
        if (sheet) {
            const rows = await q(datt,
                `SELECT DATE_FORMAT(work_date,'%Y-%m-%d') AS work_date, day_status
                   FROM att_sheet_day WHERE sheet_id = ?`, [sheet.sheet_id]);
            marks = Object.fromEntries(rows.map((r) => [r.work_date, r.day_status]));
        }

        // Approved leave from dTime. Shown either way: when leave_source is
        // 'dtime' it OWNS the L days; when 'manual' it is advisory, and a
        // mismatch is surfaced rather than silently reconciled.
        const approvedLeave = await q(dtime, `
            SELECT DATE_FORMAT(lr.start_date,'%Y-%m-%d') AS start_date,
                   DATE_FORMAT(lr.end_date,'%Y-%m-%d')   AS end_date,
                   lr.start_date_breakdown, lr.end_date_breakdown,
                   lt.leave_type
              FROM leave_requests lr
         LEFT JOIN leave_type lt ON lt.leave_type_id = lr.leave_type_id
             WHERE lr.emp_id = ? AND lr.leave_status = 'Approved'
               AND lr.end_date >= ? AND lr.start_date <= ?`,
            [req.emp_id, monthStart, monthEnd]);

        const leaveDates = new Set();
        for (const l of approvedLeave) {
            for (const d of cal.dateRange(l.start_date, l.end_date)) leaveDates.add(d);
        }

        if (cfg.leaveSource === "dtime") {
            for (const day of calendar.days) {
                if (day.day_type === "WORK" && leaveDates.has(day.date)) marks[day.date] = "L";
            }
        }

        // Per-day editability, computed server-side and echoed so the UI never
        // has to guess. The same predicate re-runs on save.
        const days = calendar.days.map((d) => ({
            ...d,
            mark: d.day_type === "WORK" ? (marks[d.date] || null) : "H",
            approved_leave: leaveDates.has(d.date),
            editable:
                d.day_type === "WORK" &&
                !(cfg.leaveSource === "dtime" && leaveDates.has(d.date)) &&
                cal.isDateEditable({
                    date: d.date, today, employee: emp, year, month,
                    sheetStatus, fillForwardFromDay: cfg.fillForwardFromDay,
                }),
        }));

        const summary = cal.summariseSheet({ calendar, marks, allowedLeave: cfg.allowedLeave });
        const lastWorking = cal.lastWorkingDate(calendar);

        const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
        const isCurrentMonth = year === ty && month === tm;
        const isFuture = year > ty || (year === ty && month > tm);
        const isPast = year < ty || (year === ty && month < tm);

        // Submit opens on the last working day of the current month; a past
        // month can be submitted whenever it is finished.
        const submitWindowOpen = isPast ? true : isCurrentMonth ? today >= lastWorking : false;

        // Mismatches between what the employee marked and what dTime approved.
        // Advisory only under 'manual' - it is a prompt, not a block.
        const leaveMismatch = cfg.leaveSource === "manual"
            ? days
                .filter((d) => d.day_type === "WORK" &&
                    ((d.approved_leave && marks[d.date] === "P") ||
                     (!d.approved_leave && marks[d.date] === "L")))
                .map((d) => ({
                    date: d.date,
                    marked: marks[d.date],
                    dtime: d.approved_leave ? "approved leave" : "no approved leave",
                }))
            : [];

        res.json({
            success: true,
            year, month, today,
            employee: emp,
            pattern,
            pattern_label: cal.PATTERNS[pattern].label,
            days,
            summary,
            holidays,
            approved_leave: approvedLeave,
            leave_source: cfg.leaveSource,
            leave_mismatch: leaveMismatch,
            sheet: {
                status: sheetStatus,
                edit_requests_used: sheet?.edit_requests_used || 0,
                edit_requests_left: Math.max(0, cfg.editLimit - (sheet?.edit_requests_used || 0)),
                submitted_time: sheet?.submitted_time || null,
            },
            flags: {
                is_current_month: isCurrentMonth,
                is_future_month: isFuture,
                is_past_month: isPast,
                before_joining: !!(emp.joining_date && monthEnd < emp.joining_date),
                last_working_date: lastWorking,
                submit_window_open: submitWindowOpen,
                can_submit: submitWindowOpen && summary.complete &&
                            ["not_started", "draft", "saved", "edit_open", "rejected"].includes(sheetStatus),
                // Download is enabled only once the sheet has been submitted.
                can_download: ["submitted", "edit_requested", "edit_open", "approved"].includes(sheetStatus),
                fill_forward_from_day: cfg.fillForwardFromDay,
            },
        });
    } catch (err) {
        console.error("[sheet] /month", err);
        res.status(500).json({ error: "Database error" });
    }
});

// ---------------------------------------------------------------------------
// Shared write path for /save and /submit.
// Re-validates every date against the edit window. A client that posts a date
// it should not be able to touch gets a 403, not a silent write.
// ---------------------------------------------------------------------------
async function writeMarks({ emp_id, year, month, marks, req }) {
    const emp = await loadEmployee(emp_id);
    if (!emp) { const e = new Error("Account inactive"); e.status = 403; throw e; }
    const cfg = await loadConfig();
    const today = todayYmd();

    const monthStart = cal.toYmd(year, month, 1);
    const monthEnd = cal.toYmd(year, month, cal.daysInMonth(year, month));

    const [patternRows, adhocRows, holidays, sheetRows] = await Promise.all([
        q(datt, `SELECT pattern FROM att_work_pattern WHERE emp_id = ? AND year = ? AND month = ?`,
          [emp_id, year, month]),
        q(datt, `SELECT DATE_FORMAT(work_date,'%Y-%m-%d') AS work_date
                   FROM att_adhoc_day WHERE emp_id = ? AND work_date BETWEEN ? AND ?`,
          [emp_id, monthStart, monthEnd]),
        q(dtime, `SELECT DATE_FORMAT(holiday_date,'%Y-%m-%d') AS holiday_date,
                         DATE_FORMAT(COALESCE(holiday_end, holiday_date),'%Y-%m-%d') AS holiday_end,
                         holiday_name, holiday_for, holiday_value
                    FROM holidays
                   WHERE holiday_date <= ? AND COALESCE(holiday_end, holiday_date) >= ?`,
          [monthEnd, monthStart]),
        q(datt, `SELECT sheet_id, status, edit_requests_used FROM att_sheet
                  WHERE emp_id = ? AND year = ? AND month = ? LIMIT 1`, [emp_id, year, month]),
    ]);

    const pattern = patternRows[0]?.pattern || cal.DEFAULT_PATTERN;
    const calendar = cal.buildMonthCalendar({
        employee: emp, year, month, pattern,
        adhocDays: adhocRows.map((a) => a.work_date), holidays,
    });
    const sheetStatus = sheetRows[0]?.status || "not_started";
    const byDate = new Map(calendar.days.map((d) => [d.date, d]));

    for (const [date, mark] of Object.entries(marks || {})) {
        const day = byDate.get(date);
        if (!day) { const e = new Error(`${date} is not in ${year}-${month}`); e.status = 400; throw e; }
        if (!["P", "L"].includes(mark)) {
            const e = new Error(`${date}: only P or L may be set by an employee`); e.status = 400; throw e;
        }
        if (day.day_type !== "WORK") {
            const e = new Error(`${date} is not a working day (${day.label})`); e.status = 403; throw e;
        }
        if (!cal.isDateEditable({ date, today, employee: emp, year, month, sheetStatus,
                                  fillForwardFromDay: cfg.fillForwardFromDay })) {
            const e = new Error(`${date} is outside your edit window`); e.status = 403; throw e;
        }
    }

    // Upsert the sheet, then the days. Week-offs and holidays are written as H
    // by the SERVER, never accepted from the client.
    let sheetId = sheetRows[0]?.sheet_id;
    if (!sheetId) {
        const r = await q(datt,
            `INSERT INTO att_sheet (emp_id, year, month, status) VALUES (?, ?, ?, 'draft')`,
            [emp_id, year, month]);
        sheetId = r.insertId;
    }

    const rows = [];
    for (const day of calendar.days) {
        if (day.day_type === "NON_EMPLOYED") continue;
        if (day.day_type !== "WORK") {
            rows.push([sheetId, day.date, "H", day.day_type, "system"]);
        } else if (marks[day.date]) {
            rows.push([sheetId, day.date, marks[day.date], "WORK", "employee"]);
        }
    }
    if (rows.length) {
        await q(datt, `
            INSERT INTO att_sheet_day (sheet_id, work_date, day_status, day_type, source)
            VALUES ?
            ON DUPLICATE KEY UPDATE day_status = VALUES(day_status),
                                    day_type   = VALUES(day_type),
                                    source     = VALUES(source)`, [rows]);
    }

    const saved = Object.fromEntries(
        (await q(datt, `SELECT DATE_FORMAT(work_date,'%Y-%m-%d') AS d, day_status
                          FROM att_sheet_day WHERE sheet_id = ?`, [sheetId]))
            .map((r) => [r.d, r.day_status])
    );

    return {
        sheetId, emp, cfg, calendar, sheetStatus,
        summary: cal.summariseSheet({ calendar, marks: saved, allowedLeave: cfg.allowedLeave }),
        lastWorking: cal.lastWorkingDate(calendar),
        today,
    };
}

const logActivity = (emp_id, year, month, action, detail, actor, ip) =>
    q(datt, `INSERT INTO att_activity (emp_id, year, month, action, detail, actor_id, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?)`, [emp_id, year, month, action, detail, actor, ip]);

// ---------------------------------------------------------------------------
// POST /save    body: { year, month, marks: { 'YYYY-MM-DD': 'P'|'L' } }
// ---------------------------------------------------------------------------
router.post("/save", verifyJWT, async (req, res) => {
    const { year, month, marks } = req.body || {};
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
        return res.status(400).json({ error: "year and month are required" });
    }
    try {
        const r = await writeMarks({ emp_id: req.emp_id, year, month, marks, req });
        if (["not_started", "draft", "saved"].includes(r.sheetStatus)) {
            await q(datt, `UPDATE att_sheet SET status = 'saved' WHERE sheet_id = ?`, [r.sheetId]);
        }
        await logActivity(req.emp_id, year, month, "Saved",
            `Present ${r.summary.present_days}, leave ${r.summary.leave_days}, unmarked ${r.summary.unmarked_days}`,
            req.emp_id, req.ip);
        res.json({ success: true, summary: r.summary });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error("[sheet] /save", err);
        res.status(500).json({ error: "Database error" });
    }
});

// ---------------------------------------------------------------------------
// POST /submit   body: { year, month, marks }
//
// Guards, in order: every working day marked, submit window open, sheet not
// already submitted. Then the approver is resolved ONCE and frozen on the
// sheet - if the employee's reporting manager changes next month, this
// month's request stays with whoever was asked to approve it.
// ---------------------------------------------------------------------------
router.post("/submit", verifyJWT, async (req, res) => {
    const { year, month, marks } = req.body || {};
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
        return res.status(400).json({ error: "year and month are required" });
    }
    try {
        const r = await writeMarks({ emp_id: req.emp_id, year, month, marks, req });

        if (["submitted", "edit_requested", "approved"].includes(r.sheetStatus)) {
            return res.status(409).json({ error: `Sheet is already ${r.sheetStatus}` });
        }
        if (!r.summary.complete) {
            return res.status(400).json({
                error: `${r.summary.unmarked_days} working day(s) are still unmarked`,
            });
        }

        const [ty, tm] = [Number(r.today.slice(0, 4)), Number(r.today.slice(5, 7))];
        const isPast = year < ty || (year === ty && month < tm);
        const isCurrent = year === ty && month === tm;
        if (!isPast && !(isCurrent && r.today >= r.lastWorking)) {
            return res.status(403).json({
                error: `Submit opens on ${r.lastWorking}, the last working day of this month`,
            });
        }

        // reporting_manager, else the first active Admin. Frozen on the sheet.
        let approver = r.emp.reporting_manager || null;
        if (approver) {
            const ok = await q(dadmin,
                `SELECT emp_id FROM employee WHERE emp_id = ? AND active = 1 AND deleted_time IS NULL`,
                [approver]);
            if (!ok.length) approver = null;
        }
        if (!approver) {
            const admins = await q(dadmin, `
                SELECT emp_id FROM employee
                 WHERE emp_access_level = 'Admin' AND active = 1 AND deleted_time IS NULL
              ORDER BY emp_id ASC LIMIT 1`);
            approver = admins[0]?.emp_id || null;
        }

        await q(datt, `
            UPDATE att_sheet
               SET status = 'submitted', submitted_time = NOW(), approver_id = ?
             WHERE sheet_id = ?`, [approver, r.sheetId]);

        await q(datt, `
            INSERT INTO att_request (sheet_id, request_type, status, reason, raised_by)
            VALUES (?, 'approval', 'pending', ?, ?)`,
            [r.sheetId, `Attendance submitted for ${year}-${String(month).padStart(2, "0")}`, req.emp_id]);

        await logActivity(req.emp_id, year, month, "Submitted",
            `Present ${r.summary.present_days}, leave ${r.summary.leave_days}, LOP ${r.summary.lop_days}`,
            req.emp_id, req.ip);

        res.json({ success: true, approver_id: approver, summary: r.summary });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error("[sheet] /submit", err);
        res.status(500).json({ error: "Database error" });
    }
});

// ---------------------------------------------------------------------------
// POST /edit-request   body: { year, month, reason }
//
// The counter increments on the REQUEST, not on the approval. Two attempts,
// not two successes - otherwise a rejected request costs nothing and the
// limit is decorative.
// ---------------------------------------------------------------------------
router.post("/edit-request", verifyJWT, async (req, res) => {
    const { year, month, reason } = req.body || {};
    if (!Number.isInteger(year) || !Number.isInteger(month) || !reason || !String(reason).trim()) {
        return res.status(400).json({ error: "year, month and a reason are required" });
    }
    try {
        const cfg = await loadConfig();
        const [sheet] = await q(datt, `
            SELECT sheet_id, status, edit_requests_used
              FROM att_sheet WHERE emp_id = ? AND year = ? AND month = ? LIMIT 1`,
            [req.emp_id, year, month]);

        if (!sheet) return res.status(404).json({ error: "No sheet to edit yet" });
        if (!["submitted", "approved"].includes(sheet.status)) {
            return res.status(409).json({ error: `Sheet is ${sheet.status} - nothing to reopen` });
        }
        if (sheet.edit_requests_used >= cfg.editLimit) {
            return res.status(403).json({
                error: `You have used all ${cfg.editLimit} edit requests for this month`,
            });
        }

        await q(datt, `
            UPDATE att_sheet
               SET status = 'edit_requested', edit_requests_used = edit_requests_used + 1
             WHERE sheet_id = ?`, [sheet.sheet_id]);

        await q(datt, `
            INSERT INTO att_request (sheet_id, request_type, status, reason, raised_by)
            VALUES (?, 'edit', 'pending', ?, ?)`,
            [sheet.sheet_id, String(reason).trim().slice(0, 500), req.emp_id]);

        await logActivity(req.emp_id, year, month, "Edit request",
            String(reason).trim().slice(0, 500), req.emp_id, req.ip);

        res.json({ success: true, edit_requests_left: cfg.editLimit - (sheet.edit_requests_used + 1) });
    } catch (err) {
        console.error("[sheet] /edit-request", err);
        res.status(500).json({ error: "Database error" });
    }
});

// ---------------------------------------------------------------------------
// GET /download?year=&month=  - CSV of the month, Excel-shaped.
//
// Gated on the sheet having been submitted. Logged, because dAdmin page 4 has
// to show downloads.
// ---------------------------------------------------------------------------
router.get("/download", verifyJWT, async (req, res) => {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
        return res.status(400).json({ error: "year and month are required" });
    }
    try {
        const emp = await loadEmployee(req.emp_id);
        if (!emp) return res.status(403).json({ error: "Account inactive" });
        const cfg = await loadConfig();

        const [sheet] = await q(datt,
            `SELECT sheet_id, status FROM att_sheet WHERE emp_id = ? AND year = ? AND month = ? LIMIT 1`,
            [req.emp_id, year, month]);
        if (!sheet || !["submitted", "edit_requested", "edit_open", "approved"].includes(sheet.status)) {
            return res.status(403).json({ error: "Submit the sheet before downloading" });
        }

        const monthStart = cal.toYmd(year, month, 1);
        const monthEnd = cal.toYmd(year, month, cal.daysInMonth(year, month));
        const [patternRows, adhocRows, holidays, markRows] = await Promise.all([
            q(datt, `SELECT pattern FROM att_work_pattern WHERE emp_id = ? AND year = ? AND month = ?`,
              [req.emp_id, year, month]),
            q(datt, `SELECT DATE_FORMAT(work_date,'%Y-%m-%d') AS work_date FROM att_adhoc_day
                      WHERE emp_id = ? AND work_date BETWEEN ? AND ?`, [req.emp_id, monthStart, monthEnd]),
            q(dtime, `SELECT DATE_FORMAT(holiday_date,'%Y-%m-%d') AS holiday_date,
                             DATE_FORMAT(COALESCE(holiday_end, holiday_date),'%Y-%m-%d') AS holiday_end,
                             holiday_name, holiday_for, holiday_value
                        FROM holidays WHERE holiday_date <= ? AND COALESCE(holiday_end, holiday_date) >= ?`,
              [monthEnd, monthStart]),
            q(datt, `SELECT DATE_FORMAT(work_date,'%Y-%m-%d') AS d, day_status
                       FROM att_sheet_day WHERE sheet_id = ?`, [sheet.sheet_id]),
        ]);

        const calendar = cal.buildMonthCalendar({
            employee: emp, year, month,
            pattern: patternRows[0]?.pattern || cal.DEFAULT_PATTERN,
            adhocDays: adhocRows.map((a) => a.work_date), holidays,
        });
        const marks = Object.fromEntries(markRows.map((r) => [r.d, r.day_status]));
        const s = cal.summariseSheet({ calendar, marks, allowedLeave: cfg.allowedLeave });

        // The designation column. loadEmployee() carries the job_position id,
        // not its name, so resolve it the same way /me does.
        const [job] = await q(dadmin,
            `SELECT job_name FROM job_position_config WHERE job_id = ? LIMIT 1`, [emp.job_position]);

        const buffer = await buildAttendanceWorkbook({
            employee: { ...emp, job_name: job?.job_name || null },
            year, month, calendar, summary: s, marks,
        });

        await logActivity(req.emp_id, year, month, "Downloaded",
            `${year}-${String(month).padStart(2, "0")} sheet`, req.emp_id, req.ip);

        const filename = workbookFilename(emp.emp_id, year, month);
        res.setHeader("Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Length", buffer.length);
        res.send(buffer);
    } catch (err) {
        console.error("[sheet] /download", err);
        res.status(500).json({ error: "Database error" });
    }
});

module.exports = router;
