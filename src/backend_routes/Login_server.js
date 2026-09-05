// ============================================================================
//  dAttendance - authentication
//
//  IDENTITY IS NEVER DUPLICATED. There is no user table in `dattendance`.
//  Staff authenticate against dadmin.employee with the same bcrypt hash and
//  the same JWT_SECRET every other dApp uses, so a password change in dAdmin
//  takes effect here immediately and there is no second copy to go stale.
//
//  The cookie is named dAttendance_token. verifyJWT also accepts
//  dolluzcorp_token so a session started at Inside D carries over.
// ============================================================================
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const router = express.Router();

const getDBConnection = require("../../config/db");
const dadmin = getDBConnection("dadmin");

const JWT_SECRET = process.env.JWT_SECRET;
const isProd = process.env.NODE_ENV === "production";

const verifyJWT = (req, res, next) => {
    const token = req.cookies.dAttendance_token || req.cookies.dolluzcorp_token;
    if (!token) return res.status(403).json({ message: "Access Denied. No Token Provided!" });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ message: "Invalid Token" });
        req.emp_id = decoded.emp_id;
        next();
    });
};

// "Remember for 14 days" on the sign-in screen. Unticked is the default and
// gives the usual working-day session; ticked extends both the cookie and the
// JWT together. They must match - a cookie that outlives its token just makes
// the next request fail with "Invalid Token" instead of asking for a login.
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 14;

const cookieOptions = (remember) => ({
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "None" : "Lax",
    maxAge: remember
        ? REMEMBER_DAYS * 24 * 60 * 60 * 1000
        : SESSION_HOURS * 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// POST /login   body: { emp_id | email, password }
//
// One failure message for every reason (unknown id, wrong password, revoked
// app access). Distinguishing them tells an attacker which employee ids exist.
// ---------------------------------------------------------------------------
router.post("/login", (req, res) => {
    const { emp_id, email, password, remember } = req.body || {};
    const identifier = (emp_id || email || "").trim();
    const keepSignedIn = remember === true;
    if (!identifier || !password) {
        return res.status(400).json({ message: "Employee ID and password are required" });
    }

    dadmin.query(
        `SELECT emp_id, emp_first_name, emp_last_name, emp_mail_id,
                account_pass, emp_access_level, active, deleted_time, app_dAttendance
           FROM employee
          WHERE (emp_id = ? OR emp_mail_id = ?)
          LIMIT 1`,
        [identifier, identifier],
        async (err, rows) => {
            if (err) {
                console.error("[dAttendance/login]", err);
                return res.status(500).json({ message: "Database error" });
            }
            const user = rows && rows[0];
            const fail = () => res.status(401).json({ message: "Invalid credentials" });

            if (!user || user.deleted_time || !user.active) return fail();
            if (user.app_dAttendance === 0) return fail();
            if (!user.account_pass) return fail();

            let ok = false;
            try { ok = await bcrypt.compare(password, user.account_pass); } catch { ok = false; }
            if (!ok) return fail();

            const token = jwt.sign({ emp_id: user.emp_id }, JWT_SECRET, {
                expiresIn: keepSignedIn ? `${REMEMBER_DAYS}d` : `${SESSION_HOURS}h`,
            });
            res.cookie("dAttendance_token", token, cookieOptions(keepSignedIn));
            res.json({
                success: true,
                emp_id: user.emp_id,
                emp_name: `${user.emp_first_name} ${user.emp_last_name}`.trim(),
                remembered: keepSignedIn,
            });
        }
    );
});

// ---------------------------------------------------------------------------
// GET /me  - who is logged in. The frontend session context calls this on load.
// ---------------------------------------------------------------------------
router.get("/me", verifyJWT, (req, res) => {
    dadmin.query(
        `SELECT e.emp_id,
                CONCAT_WS(' ', e.emp_first_name, e.emp_last_name) AS emp_name,
                e.emp_mail_id, e.emp_location, e.emp_department, e.job_position,
                e.reporting_manager, e.emp_access_level,
                DATE_FORMAT(e.joining_date, '%Y-%m-%d') AS joining_date,
                j.job_name, d.department_name
           FROM employee e
      LEFT JOIN job_position_config j ON j.job_id = e.job_position
      LEFT JOIN department_config   d ON d.department_id = e.emp_department
          WHERE e.emp_id = ? AND e.deleted_time IS NULL AND e.active = 1
          LIMIT 1`,
        [req.emp_id],
        (err, rows) => {
            if (err) {
                console.error("[dAttendance/me]", err);
                return res.status(500).json({ message: "Database error" });
            }
            if (!rows || !rows[0]) return res.status(403).json({ message: "Account inactive" });
            res.json({ success: true, employee: rows[0] });
        }
    );
});

router.post("/logout", (req, res) => {
    res.clearCookie("dAttendance_token", {
        httpOnly: true, secure: isProd, sameSite: isProd ? "None" : "Lax",
    });
    res.json({ success: true });
});

module.exports = { router, verifyJWT };
