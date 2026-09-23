// ============================================================================
//  dAttendance - authentication.
//
//  IDENTITY IS NEVER DUPLICATED. There is no user table in `dattendance`.
//  Staff authenticate against dadmin.employee with the same bcrypt hash and
//  the same JWT_SECRET every other dApp uses, so a password change in dAdmin
//  takes effect here immediately and there is no second copy to go stale.
//
//  SIGN-IN IS TWO STEPS
//  --------------------
//    POST /login        employee id + password  ->  a code is emailed
//    POST /verify-otp   the code                ->  the session cookie
//
//  The password alone never issues a session. The one exception is a browser
//  the employee has already trusted with "Remember for 14 days": that browser
//  holds a dAttendance_device cookie and skips straight to the session.
//
//  PASSWORD RESET
//  --------------
//    POST /forgot/start   email        ->  a code is emailed
//    POST /forgot/verify  the code     ->  a short-lived reset token
//    POST /forgot/reset   new password ->  writes dadmin.employee.account_pass
//
//  Codes are bcrypt-hashed in att_otp, capped at N wrong guesses, consumed on
//  use, and expire in two minutes. See sql/004_auth_otp.sql.
//
//  Signing out sets dAttendance_signedout, which makes verifyJWT ignore the
//  shared Inside D cookie until the next sign-in here. Without it, Logout
//  cannot log anyone out while Inside D is still signed in.
//
//  The cookie is dAttendance_token; verifyJWT also accepts dolluzcorp_token
//  so a session started at Inside D carries over.
// ============================================================================
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const router = express.Router();

const getDBConnection = require("../../config/db");
const otpUtil = require("./utils/otp");

const dadmin = getDBConnection("dadmin");
const datt = getDBConnection("dattendance");

const JWT_SECRET = process.env.JWT_SECRET;
const isProd = process.env.NODE_ENV === "production";

// Which app this is, as dAdmin's Login Page Config knows it. Must match
// LOGIN_APPS in dAdmin exactly, case included, or the revocation check below
// silently never matches.
const APP_KEY = "dAttendance";

const q = (db, sql, params = []) =>
    new Promise((resolve, reject) =>
        db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

// ---------------------------------------------------------------------------
// Config, read from att_config so none of this is a magic number in JS.
//
// NOT `Number(x) || fallback`. That reads a configured 0 as missing, because
// 0 is falsy - so setting otp_resend_seconds to 0 to turn the throttle off
// would silently restore the 30s default instead. Fall back only when the
// value is genuinely absent or not a number, then clamp to a sane floor.
// ---------------------------------------------------------------------------
const num = (raw, fallback, min) => {
    const n = Number(raw);
    const v = (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) ? fallback : n;
    return min === undefined ? v : Math.max(min, v);
};

const loadAuthConfig = async () => {
    let c = {};
    try {
        const rows = await q(datt, `SELECT config_key, config_value FROM att_config`);
        c = Object.fromEntries(rows.map((r) => [r.config_key, r.config_value]));
    } catch (err) {
        console.error("[auth] att_config unreadable, using defaults:", err.message);
    }
    return {
        // A zero-minute code would be expired before it was read, and zero
        // attempts would lock everyone out, so those two have a floor of 1.
        otpMinutes: num(c.otp_expiry_minutes, 2, 1),
        maxAttempts: num(c.otp_max_attempts, 5, 1),
        // 0 is a legitimate setting here: no gap between resends.
        resendSeconds: num(c.otp_resend_seconds, 30, 0),
        maxPerHour: num(c.otp_max_per_hour, 6, 1),
        trustedDays: num(c.trusted_device_days, 14, 1),
    };
};

const SESSION_HOURS = 12;

// Set by /logout, cleared by issueSession. It records that somebody signed out
// of dAttendance ON PURPOSE, so the shared Inside D cookie stops standing in for
// a dAttendance session until they sign in here again.
//
// Host-only (no domain), like every cookie this app sets, so it is sent to
// dAttendance and nowhere else. Inside D never sees it and its own session is
// never touched - signing out here signs you out of THIS app only.
//
// It outlives the shared cookie on purpose: dolluzcorp_token lasts 7 days, so a
// shorter marker would let the fallback quietly come back before then.
const SIGNED_OUT_COOKIE = "dAttendance_signedout";
const SIGNED_OUT_DAYS = 7;

const sessionCookie = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "None" : "Lax",
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
};
const deviceCookie = (days) => ({
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "None" : "Lax",
    maxAge: days * 24 * 60 * 60 * 1000,
});

// ── Session revocation ───────────────────────────────────────────────────
// dAdmin -> Inside D -> Login Page Config -> "Revoke remembered" now also writes
// a marker to dadmin.login_session_revoke. Without this check, revoking would
// clear the remembered browser and still leave someone signed in here.
//
// (dAttendance's session JWT does expire - SESSION_HOURS, 12h - unlike the
// no-expiry tokens elsewhere in the suite. That bounds the damage, but twelve
// hours is still far too long for a session an admin has deliberately ended.)
//
// A token is dead if it was issued in a second STRICTLY EARLIER than the
// revocation. Comparing whole seconds matters - jwt's `iat` is second-granular,
// so a revoke at 10:00:00.500 followed by a fresh sign-in at 10:00:00.700 would
// otherwise kill the brand-new token the instant it was issued.
//
// revoked_at is written by dAdmin with server-side NOW(3) and read back here
// with server-side UNIX_TIMESTAMP(), so both ends are evaluated by the same
// MySQL server in the same zone - the pools' client-side timezone option never
// comes into it.
//
// emp_id '*' is an app-wide marker: revoke-all ends every session for the app.
//
// `dadmin`, not `datt`: the table lives in the dadmin schema.
function sessionRevokedAfter(emp_id, cb) {
    dadmin.query(
        `SELECT UNIX_TIMESTAMP(MAX(revoked_at)) AS sec
           FROM login_session_revoke
          WHERE app_key = ? AND emp_id IN (?, '*')`,
        [APP_KEY, emp_id],
        (err, rows) => {
            if (err) {
                // Deliberately fails OPEN. This is a revocation list, not the
                // authentication itself: a transient DB error signing every
                // user of the app out is a worse outcome than a revoked session
                // surviving a few seconds. Logged loudly instead.
                console.error("session-revoke check failed:", err.message);
                return cb(null);
            }
            cb(rows?.[0]?.sec ? Math.floor(Number(rows[0].sec)) : null);
        }
    );
}

const verifyJWT = (req, res, next) => {
    // dolluzcorp_token is Inside D's cookie on .dolluzcorp.com, accepted here so
    // somebody arriving from Inside D is already signed in. After an explicit
    // sign-out that fallback has to stand down: /logout clears
    // dAttendance_token, and without this the very next request would sign the
    // person straight back in from Inside D's cookie - which is exactly what it
    // used to do, leaving Logout unable to log anyone out.
    const signedOut = req.cookies[SIGNED_OUT_COOKIE] === "1";
    const token = req.cookies.dAttendance_token || (signedOut ? null : req.cookies.dolluzcorp_token);
    if (!token) return res.status(403).json({ message: "Access Denied. No Token Provided!" });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ message: "Invalid Token" });
        // A challenge token is not a session. Without this check, the token
        // handed out mid-sign-in would open every employee endpoint.
        if (decoded.typ && decoded.typ !== "session") {
            return res.status(403).json({ message: "Invalid Token" });
        }
        // AFTER the typ check above, never instead of it: a challenge token
        // must still never authenticate a request, and rejecting it first also
        // means it never costs a database round trip.
        sessionRevokedAfter(decoded.emp_id, (revokedSec) => {
            if (revokedSec !== null && decoded.iat && revokedSec > decoded.iat) {
                // Cleared with the attributes it was SET with (same as /logout).
                // In production the cookie is SameSite=None; Secure, and a bare
                // clearCookie() would not match it - the browser would keep
                // sending the dead token and every request would 401 again.
                res.clearCookie("dAttendance_token",
                    { httpOnly: true, secure: isProd, sameSite: isProd ? "None" : "Lax" });
                return res.status(401).json({ message: "SESSION_REVOKED" });
            }
            req.emp_id = decoded.emp_id;
            next();
        });
    });
};

const issueSession = (res, emp_id) => {
    const token = jwt.sign({ emp_id, typ: "session" }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
    res.cookie("dAttendance_token", token, sessionCookie);
    // Both ways in - password only, and password plus emailed code - land here,
    // so this is the one place that has to lift the marker. From now until the
    // next sign-out, arriving from Inside D signs you in again as it always did.
    res.clearCookie(SIGNED_OUT_COOKIE, { httpOnly: true, secure: isProd, sameSite: isProd ? "None" : "Lax" });
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const findEmployee = async (identifier) => {
    const rows = await q(dadmin, `
        SELECT emp_id, emp_first_name, emp_last_name, emp_mail_id,
               account_pass, emp_access_level, active, deleted_time, app_dAttendance
          FROM employee
         WHERE (emp_id = ? OR emp_mail_id = ?)
         LIMIT 1`, [identifier, identifier]);
    return rows[0] || null;
};

const employeeUsable = (u) =>
    !!u && !u.deleted_time && !!u.active && u.app_dAttendance !== 0;

/**
 * Creates a code, mails it, and returns the signed challenge the client holds.
 * Throws {status,message} for a throttle so callers can surface it verbatim.
 */
async function issueOtp({ emp, purpose, cfg, ip }) {
    const [recent] = await q(datt, `
        SELECT COUNT(*) AS n,
               MAX(created_time) AS last_at,
               TIMESTAMPDIFF(SECOND, MAX(created_time), NOW()) AS since
          FROM att_otp
         WHERE emp_id = ? AND purpose = ? AND created_time > NOW() - INTERVAL 1 HOUR`,
        [emp.emp_id, purpose]);

    if (recent && recent.n >= cfg.maxPerHour) {
        const e = new Error("Too many codes requested. Try again in an hour.");
        e.status = 429; throw e;
    }
    if (recent && recent.last_at && recent.since < cfg.resendSeconds) {
        const e = new Error(`Please wait ${cfg.resendSeconds - recent.since}s before requesting another code.`);
        e.status = 429; throw e;
    }

    const code = otpUtil.generateOtp();
    const hash = await otpUtil.hashOtp(code);

    const ins = await q(datt, `
        INSERT INTO att_otp (emp_id, purpose, otp_hash, expires_at, ip_address)
        VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE, ?)`,
        [emp.emp_id, purpose, hash, cfg.otpMinutes, ip || null]);

    const delivered = await otpUtil.sendOtpMail({
        to: emp.emp_mail_id,
        firstName: emp.emp_first_name,
        otp: code,
        purpose,
        minutes: cfg.otpMinutes,
    });
    if (!delivered) {
        const e = new Error("Could not send the code. Please try again shortly.");
        e.status = 502; throw e;
    }

    return jwt.sign(
        { otp_id: ins.insertId, emp_id: emp.emp_id, purpose, typ: "challenge" },
        JWT_SECRET,
        { expiresIn: `${cfg.otpMinutes + 3}m` }
    );
}

/**
 * Checks a submitted code against its challenge. Returns { emp_id } or throws.
 * Every failure says the same thing, so a wrong code and an expired one are
 * indistinguishable from outside.
 */
async function consumeOtp({ challenge, otp, purpose, cfg }) {
    const bad = () => {
        const e = new Error("That code is not valid or has expired.");
        e.status = 401; return e;
    };

    let claims;
    try { claims = jwt.verify(challenge, JWT_SECRET); }
    catch { throw bad(); }

    if (claims.typ !== "challenge" || claims.purpose !== purpose) throw bad();
    // A challenge minted for an address with no account. It exists only so the
    // caller cannot tell registered emails from unregistered ones.
    if (claims.unknown) throw bad();

    const [row] = await q(datt, `
        SELECT otp_id, emp_id, otp_hash, attempts, consumed_time,
               (expires_at < NOW()) AS expired
          FROM att_otp WHERE otp_id = ? AND purpose = ? LIMIT 1`,
        [claims.otp_id, purpose]);

    if (!row || row.consumed_time || row.expired) throw bad();
    if (row.attempts >= cfg.maxAttempts) throw bad();

    const ok = await otpUtil.verifyOtp(otp, row.otp_hash);
    if (!ok) {
        await q(datt, `UPDATE att_otp SET attempts = attempts + 1 WHERE otp_id = ?`, [row.otp_id]);
        throw bad();
    }

    await q(datt, `UPDATE att_otp SET consumed_time = NOW() WHERE otp_id = ?`, [row.otp_id]);
    return { emp_id: row.emp_id, otp_id: row.otp_id };
}

/** True when this browser has been trusted for this employee and is not expired. */
// dAdmin -> Inside D -> Login Page Config decides whether dAttendance asks for
// an emailed code, and how long "remember" lasts. Read on every sign-in, so a
// change there applies to the very next attempt with no restart.
//
// Only those two settings moved. The code's own mechanics - expiry, attempts,
// resend gap, sends per hour - stay in att_config, and trust stays device-level.
//
// Fails CLOSED: on any error or a missing row, two-step stays ON with
// att_config's own day count - a broken read must never switch verification off.
async function signinPolicy(fallbackDays) {
    try {
        const rows = await q(dadmin,
            `SELECT two_factor_enabled, trust_days FROM login_app_config WHERE app_key = ?`,
            [APP_KEY]);
        if (!rows.length) return { enabled: true, days: fallbackDays };
        const days = Number(rows[0].trust_days);
        return {
            enabled: Number(rows[0].two_factor_enabled) !== 0,
            days: Number.isFinite(days) && days >= 1 ? days : fallbackDays,
        };
    } catch (err) {
        console.error("[auth] sign-in policy unreadable, two-step stays on:", err.message);
        return { enabled: true, days: fallbackDays };
    }
}

async function deviceTrusted(req, emp_id) {
    const raw = req.cookies?.dAttendance_device;
    if (!raw) return false;
    const rows = await q(datt, `
        SELECT device_id FROM att_trusted_device
         WHERE token_hash = ? AND emp_id = ? AND revoked_time IS NULL AND expires_at > NOW()
         LIMIT 1`, [otpUtil.sha256(raw), emp_id]);
    if (!rows.length) return false;
    await q(datt, `UPDATE att_trusted_device SET last_used_time = NOW() WHERE device_id = ?`,
        [rows[0].device_id]);
    return true;
}

async function trustDevice(req, res, emp_id, days) {
    const { token, hash } = otpUtil.deviceToken();
    await q(datt, `
        INSERT INTO att_trusted_device (emp_id, token_hash, expires_at, user_agent, ip_address)
        VALUES (?, ?, NOW() + INTERVAL ? DAY, ?, ?)`,
        [emp_id, hash, days, String(req.get("user-agent") || "").slice(0, 255), req.ip]);
    res.cookie("dAttendance_device", token, deviceCookie(days));
}

// ===========================================================================
//  STEP 1 - password
//  POST /login  { emp_id | email, password, remember }
//
//  One failure message for every reason (unknown id, wrong password, revoked
//  app access). Distinguishing them tells an attacker which ids exist.
// ===========================================================================
router.post("/login", async (req, res) => {
    const { emp_id, email, password, remember } = req.body || {};
    const identifier = (emp_id || email || "").trim();
    if (!identifier || !password) {
        return res.status(400).json({ message: "Employee ID and password are required" });
    }

    try {
        const cfg = await loadAuthConfig();
        const user = await findEmployee(identifier);
        const fail = () => res.status(401).json({ message: "Invalid credentials" });

        if (!employeeUsable(user) || !user.account_pass) return fail();

        let ok = false;
        try { ok = await bcrypt.compare(password, user.account_pass); } catch { ok = false; }
        if (!ok) return fail();

        // No emailed code when dAdmin has two-step switched off for this app,
        // or when this browser is already trusted. Both are decided only here,
        // AFTER the password check above - never instead of it.
        const policy = await signinPolicy(cfg.trustedDays);
        if (!policy.enabled || (await deviceTrusted(req, user.emp_id))) {
            issueSession(res, user.emp_id);
            return res.json({
                success: true,
                otpRequired: false,
                emp_id: user.emp_id,
                emp_name: `${user.emp_first_name} ${user.emp_last_name}`.trim(),
            });
        }

        if (!user.emp_mail_id) {
            return res.status(409).json({
                message: "No email address is on file for your account, so a code cannot be sent. Ask an admin to add one in dAdmin.",
            });
        }

        const challenge = await issueOtp({ emp: user, purpose: "login", cfg, ip: req.ip });
        res.json({
            success: true,
            otpRequired: true,
            challenge,
            sent_to: otpUtil.maskEmail(user.emp_mail_id),
            expires_in: cfg.otpMinutes * 60,
            resend_after: cfg.resendSeconds,
            remember_days: policy.days,
            // Echoed only so the code screen can keep the tick state visible.
            // /verify-otp reads its own body for this, which is safe: only the
            // person holding the emailed code can reach that step at all.
            remember: remember === true,
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error("[dAttendance/login]", err);
        res.status(500).json({ message: "Database error" });
    }
});

// ===========================================================================
//  STEP 2 - the code
//  POST /verify-otp  { challenge, otp, remember }
// ===========================================================================
router.post("/verify-otp", async (req, res) => {
    const { challenge, otp, remember } = req.body || {};
    if (!challenge || !otp) {
        return res.status(400).json({ message: "The code is required" });
    }
    try {
        const cfg = await loadAuthConfig();
        const { emp_id } = await consumeOtp({ challenge, otp, purpose: "login", cfg });

        // Re-check the account between the two steps. Access could have been
        // revoked in dAdmin while the code was in the employee's inbox.
        const user = await findEmployee(emp_id);
        if (!employeeUsable(user)) return res.status(401).json({ message: "Invalid credentials" });

        issueSession(res, emp_id);
        if (remember === true) {
            const policy = await signinPolicy(cfg.trustedDays);
            await trustDevice(req, res, emp_id, policy.days);
        }

        res.json({
            success: true,
            emp_id,
            emp_name: `${user.emp_first_name} ${user.emp_last_name}`.trim(),
            remembered: remember === true,
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error("[dAttendance/verify-otp]", err);
        res.status(500).json({ message: "Database error" });
    }
});

// POST /resend-otp  { challenge }  - a fresh code, a fresh challenge.
router.post("/resend-otp", async (req, res) => {
    const { challenge } = req.body || {};
    if (!challenge) return res.status(400).json({ message: "Nothing to resend" });
    try {
        const cfg = await loadAuthConfig();
        let claims;
        try { claims = jwt.verify(challenge, JWT_SECRET); }
        catch { return res.status(401).json({ message: "Start again - this request has expired." }); }
        if (claims.typ !== "challenge") return res.status(400).json({ message: "Nothing to resend" });

        // An unknown-address challenge must behave exactly like a real one.
        if (claims.unknown) {
            return res.json({ success: true, challenge, resend_after: cfg.resendSeconds });
        }

        const user = await findEmployee(claims.emp_id);
        if (!employeeUsable(user)) return res.status(401).json({ message: "Invalid credentials" });

        const fresh = await issueOtp({ emp: user, purpose: claims.purpose, cfg, ip: req.ip });
        res.json({
            success: true,
            challenge: fresh,
            sent_to: otpUtil.maskEmail(user.emp_mail_id),
            expires_in: cfg.otpMinutes * 60,
            resend_after: cfg.resendSeconds,
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error("[dAttendance/resend-otp]", err);
        res.status(500).json({ message: "Database error" });
    }
});

// ===========================================================================
//  PASSWORD RESET
// ===========================================================================

// POST /forgot/start  { email }
//
// Always answers the same way. An unknown address still gets a challenge - one
// that can never verify - so the response cannot be used to test whether an
// address has an account.
router.post("/forgot/start", async (req, res) => {
    const { email } = req.body || {};
    const identifier = String(email || "").trim();
    if (!identifier) return res.status(400).json({ message: "Enter your employee ID or work email" });

    try {
        const cfg = await loadAuthConfig();
        const user = await findEmployee(identifier);

        if (!employeeUsable(user) || !user.emp_mail_id) {
            return res.json({
                success: true,
                challenge: jwt.sign({ unknown: true, purpose: "reset", typ: "challenge" },
                    JWT_SECRET, { expiresIn: `${cfg.otpMinutes + 3}m` }),
                sent_to: otpUtil.maskEmail(identifier.includes("@") ? identifier : "user@dolluzcorp.com"),
                expires_in: cfg.otpMinutes * 60,
                resend_after: cfg.resendSeconds,
            });
        }

        const challenge = await issueOtp({ emp: user, purpose: "reset", cfg, ip: req.ip });
        res.json({
            success: true,
            challenge,
            sent_to: otpUtil.maskEmail(user.emp_mail_id),
            expires_in: cfg.otpMinutes * 60,
            resend_after: cfg.resendSeconds,
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error("[dAttendance/forgot/start]", err);
        res.status(500).json({ message: "Database error" });
    }
});

// POST /forgot/verify  { challenge, otp }  ->  a token good for one reset.
router.post("/forgot/verify", async (req, res) => {
    const { challenge, otp } = req.body || {};
    if (!challenge || !otp) return res.status(400).json({ message: "The code is required" });
    try {
        const cfg = await loadAuthConfig();
        const { emp_id, otp_id } = await consumeOtp({ challenge, otp, purpose: "reset", cfg });
        res.json({
            success: true,
            // Short window: this proves the mailbox, nothing more, and it is
            // spent on the very next call.
            reset_token: jwt.sign({ emp_id, otp_id, typ: "reset" }, JWT_SECRET, { expiresIn: "10m" }),
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error("[dAttendance/forgot/verify]", err);
        res.status(500).json({ message: "Database error" });
    }
});

// Minimum the reset will accept. Deliberately modest - dAdmin does not enforce
// one at all, and a rule stricter than the rest of the suite would lock people
// out of the app they use to get paid.
const passwordProblem = (pw) => {
    if (typeof pw !== "string" || pw.length < 8) return "Use at least 8 characters.";
    if (!/[A-Za-z]/.test(pw)) return "Include at least one letter.";
    if (!/[0-9]/.test(pw)) return "Include at least one number.";
    if (pw.length > 128) return "That password is too long.";
    return null;
};

// POST /forgot/reset  { reset_token, password, confirm }
router.post("/forgot/reset", async (req, res) => {
    const { reset_token, password, confirm } = req.body || {};
    if (!reset_token) return res.status(400).json({ message: "Start again - this request has expired." });
    if (confirm !== undefined && password !== confirm) {
        return res.status(400).json({ message: "The two passwords do not match." });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ message: problem });

    try {
        let claims;
        try { claims = jwt.verify(reset_token, JWT_SECRET); }
        catch { return res.status(401).json({ message: "Start again - this request has expired." }); }
        if (claims.typ !== "reset") return res.status(401).json({ message: "Start again - this request has expired." });

        // The OTP row is the single-use receipt for the reset. reset_spent_time
        // is a separate marker from consumed_time on purpose: consumed_time was
        // already set when the code was verified, so re-using it here would
        // match on every replay and the token would never actually be spent.
        // This UPDATE affects a row only the first time it runs.
        const spend = await q(datt, `
            UPDATE att_otp SET reset_spent_time = NOW()
             WHERE otp_id = ? AND emp_id = ? AND purpose = 'reset'
               AND consumed_time IS NOT NULL
               AND reset_spent_time IS NULL
               AND consumed_time > NOW() - INTERVAL 15 MINUTE`,
            [claims.otp_id, claims.emp_id]);
        if (!spend.affectedRows) {
            return res.status(401).json({ message: "Start again - this request has expired." });
        }

        const user = await findEmployee(claims.emp_id);
        if (!employeeUsable(user)) return res.status(401).json({ message: "Invalid credentials" });

        const hash = await bcrypt.hash(password, 10);
        // Only account_pass, matching dAdmin's own reset. The plaintext
        // account_pass_text column is deliberately left alone - see the
        // security note in the project docs; it should be dropped, not fed.
        await q(dadmin, `
            UPDATE employee SET account_pass = ?, updated_time = NOW()
             WHERE emp_id = ? AND deleted_time IS NULL`, [hash, claims.emp_id]);

        // A password change invalidates every remembered browser. Whoever
        // reset it may be locking someone else out on purpose.
        await q(datt, `
            UPDATE att_trusted_device SET revoked_time = NOW()
             WHERE emp_id = ? AND revoked_time IS NULL`, [claims.emp_id]);
        res.clearCookie("dAttendance_device", { httpOnly: true, secure: isProd, sameSite: isProd ? "None" : "Lax" });

        res.json({ success: true });
    } catch (err) {
        console.error("[dAttendance/forgot/reset]", err);
        res.status(500).json({ message: "Database error" });
    }
});

// ---------------------------------------------------------------------------
// GET /me  - who is logged in. The frontend session context calls this on load.
//
// profile_letters and profile_color are NOT columns - dadmin.employee has
// neither. dSlip derives them per request, and this is a byte-for-byte copy of
// that derivation so the same person gets the same avatar colour in both apps.
// If dSlip's generator ever changes, change it here too.
// ---------------------------------------------------------------------------
const generateColorFromText = (text) => {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    return `hsl(${hue}, 70%, 60%)`;
};

/** dSlip title-cases the first name and keeps at most two words. Mirrored. */
const withProfile = (emp) => {
    const firstName = emp.emp_first_name
        ? emp.emp_first_name.split(" ")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .slice(0, 2).join(" ")
        : "";
    return {
        ...emp,
        emp_first_name: firstName,
        profile_letters: firstName.charAt(0).toUpperCase(),
        profile_color: generateColorFromText(firstName || "User"),
    };
};

router.get("/me", verifyJWT, (req, res) => {
    dadmin.query(
        `SELECT e.emp_id, e.emp_first_name, e.emp_last_name,
                CONCAT_WS(' ', e.emp_first_name, e.emp_last_name) AS emp_name,
                e.emp_mail_id, e.emp_location, e.emp_department, e.job_position,
                e.reporting_manager, e.emp_access_level, e.emp_profile_img,
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
            res.json({ success: true, employee: withProfile(rows[0]) });
        }
    );
});

// Signing out ends the session but keeps the trusted browser - that is the
// point of "remember this device". Pass { forget: true } to drop it too.
router.post("/logout", async (req, res) => {
    const base = { httpOnly: true, secure: isProd, sameSite: isProd ? "None" : "Lax" };
    res.clearCookie("dAttendance_token", base);
    // Clearing our own cookie is not enough while Inside D's is still in the
    // browser - verifyJWT would accept that one instead and the next request
    // would be signed in again. This marker is what makes the sign-out stick.
    // Inside D's cookie is deliberately NOT cleared: ending its session too
    // would sign the person out of every app in the suite.
    res.cookie(SIGNED_OUT_COOKIE, "1", { ...base, maxAge: SIGNED_OUT_DAYS * 24 * 60 * 60 * 1000 });

    if (req.body?.forget === true && req.cookies?.dAttendance_device) {
        try {
            await q(datt, `UPDATE att_trusted_device SET revoked_time = NOW() WHERE token_hash = ?`,
                [otpUtil.sha256(req.cookies.dAttendance_device)]);
        } catch (err) { console.error("[dAttendance/logout] revoke failed:", err.message); }
        res.clearCookie("dAttendance_device", base);
    }
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
//  Change password with the CURRENT password
//
//  The other way to a new password is /forgot/* - prove the mailbox with an
//  emailed code. This is the route for someone who simply knows their password
//  and is already signed in, which is why both halves sit behind verifyJWT:
//  /login?changePassword is reached FROM the app, so the session cookie is
//  still there. No session, no old-password route - the UI sends those people
//  to the emailed-code flow instead.
//
//  Deliberately NOT dAdmin's shape. Its /update-password takes either a cookie
//  or an OTP in one unguarded route; keeping the two paths apart means neither
//  can be used to stand in for the other.
// ---------------------------------------------------------------------------

// POST /change-password/verify   body: { current }
//
// Grants nothing. It exists only so the UI can advance a screen rather than
// making someone type a new password twice before being told the old one was
// wrong. The real check is in POST /change-password, which repeats it.
router.post("/change-password/verify", verifyJWT, async (req, res) => {
    const current = req.body?.current;
    if (typeof current !== "string" || !current) {
        return res.status(401).json({ message: "That password is not correct." });
    }
    try {
        const user = await findEmployee(req.emp_id);
        // Same single message whatever went wrong - a missing account, a
        // disabled one and a wrong password are indistinguishable from here,
        // exactly as /login treats them.
        if (!employeeUsable(user) || !user.account_pass) {
            return res.status(401).json({ message: "That password is not correct." });
        }
        const ok = await bcrypt.compare(current, user.account_pass);
        if (!ok) return res.status(401).json({ message: "That password is not correct." });

        res.json({ success: true });
    } catch (err) {
        console.error("[dAttendance/change-password/verify]", err);
        res.status(500).json({ message: "Database error" });
    }
});

// POST /change-password   body: { current, password, confirm }
router.post("/change-password", verifyJWT, async (req, res) => {
    const { current, password, confirm } = req.body || {};

    if (confirm !== undefined && password !== confirm) {
        return res.status(400).json({ message: "The two passwords do not match." });
    }
    // The same rules /forgot/reset applies, from the same function: two routes
    // to a new password must not accept different passwords.
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ message: problem });

    try {
        const user = await findEmployee(req.emp_id);
        if (!employeeUsable(user) || !user.account_pass) {
            return res.status(401).json({ message: "That password is not correct." });
        }

        // Checked AGAIN here, not merely at /verify. That call grants nothing
        // and leaves no state, so a client that skipped it - or one replaying a
        // stale advance - reaches this point with no proof of anything. The
        // check that matters is the one at the point of write.
        if (typeof current !== "string" || !current ||
            !(await bcrypt.compare(current, user.account_pass))) {
            return res.status(401).json({ message: "That password is not correct." });
        }

        if (await bcrypt.compare(password, user.account_pass)) {
            return res.status(400).json({ message: "That is already your password." });
        }

        const hash = await bcrypt.hash(password, 10);
        // Only account_pass, matching /forgot/reset and dAdmin's own reset. The
        // plaintext account_pass_text column is deliberately left alone.
        await q(dadmin, `
            UPDATE employee SET account_pass = ?, updated_time = NOW()
             WHERE emp_id = ? AND deleted_time IS NULL`, [hash, user.emp_id]);

        // Identical to /forgot/reset: a changed password drops every remembered
        // browser. The UI promises this on both screens, and a route that
        // quietly skipped it would make that promise false.
        await q(datt, `
            UPDATE att_trusted_device SET revoked_time = NOW()
             WHERE emp_id = ? AND revoked_time IS NULL`, [user.emp_id]);
        res.clearCookie("dAttendance_device", { httpOnly: true, secure: isProd, sameSite: isProd ? "None" : "Lax" });

        res.json({ success: true });
    } catch (err) {
        console.error("[dAttendance/change-password]", err);
        res.status(500).json({ message: "Database error" });
    }
});

module.exports = { router, verifyJWT };

