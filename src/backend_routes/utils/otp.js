// ============================================================================
//  OTP generation, hashing and the sign-in / reset mail.
//
//  Same shape as dEpr's utils/otp.js: the code is bcrypt-hashed before it is
//  stored and compared against the hash, so the database never holds anything
//  that can be used to sign in. dAdmin's older `otpstorage` table keeps codes
//  in plain text - deliberately not reused here.
// ============================================================================
require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const sgMail = require("@sendgrid/mail");

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const OTP_LENGTH = Number(process.env.OTP_LENGTH) || 6;
const ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;
const FROM_EMAIL = process.env.DATTENDANCE_FROM_EMAIL || '"dAttendance" <connect@dolluzcorp.com>';

/** A zero-padded numeric code. crypto.randomInt, not Math.random. */
function generateOtp() {
    return String(crypto.randomInt(0, Math.pow(10, OTP_LENGTH))).padStart(OTP_LENGTH, "0");
}

const hashOtp = (otp) => bcrypt.hash(otp, ROUNDS);

/** Never throws on a bad hash - a malformed row just fails to verify. */
async function verifyOtp(plain, hash) {
    try { return await bcrypt.compare(String(plain), String(hash)); }
    catch { return false; }
}

/** 32 random bytes for the trusted-device cookie, plus the hash we store. */
function deviceToken() {
    const token = crypto.randomBytes(32).toString("hex");
    return { token, hash: sha256(token) };
}
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

/** j***@dolluzcorp.com - enough to confirm the right mailbox, not to harvest. */
function maskEmail(email) {
    const [user, domain] = String(email || "").split("@");
    if (!domain) return "your email";
    const head = user.slice(0, 1);
    return `${head}${"*".repeat(Math.max(2, user.length - 1))}@${domain}`;
}

// ---------------------------------------------------------------------------
//  The mail. Markup copied from dAdmin's sign-in mail (issueLoginOtp in its
//  Login_server.js) with only the app name changed, so dAdmin, dSlip and this
//  are one family. Colours, masthead and footer come from there - do not
//  "improve" them here without changing all three.
// ---------------------------------------------------------------------------
function buildOtpMail({ to, firstName, otp, purpose, minutes }) {
    const isReset = purpose === "reset";

    // The code leads the subject on purpose: it shows in the notification
    // preview, so it can be read without opening the mail. Same as dAdmin.
    const subject = isReset
        ? `${otp} is your dAttendance password reset code`
        : `${otp} is your dAttendance sign-in code`;

    const title = isReset ? "Password reset code" : "Your sign-in code";

    // dAdmin's sign-in wording, verbatim but for the app name. The expiry
    // sentence is appended below rather than written into each lead, so the two
    // purposes cannot drift apart on it.
    const lead = isReset
        ? "We received a request to reset your <strong>dAttendance</strong> password. Use the code below to confirm it is you."
        : "Someone entered the correct password for your <strong>dAttendance</strong> account. Enter the code below to finish signing in.";

    // Reaching the sign-in step means the password was ALREADY correct, so
    // "ignore this and you're fine" would be false - somebody else knows it.
    // A reset proves nothing about who asked, so there the softer line is right.
    const warning = isReset
        ? "If this was not you, ignore this email and your password stays unchanged. Never share this code."
        : "If this was not you, your password is known to someone else. Change it immediately and tell admin@dolluzcorp.com. Never share this code.";

    const footerLine = isReset
        ? "Dolluz Corp &middot; dAttendance Password Reset OTP"
        : "Dolluz Corp &middot; dAttendance Sign-in Verification";

    // Read from att_config.otp_expiry_minutes, never hard-coded: the mail must
    // not claim 2 minutes if an admin sets something else.
    const expiry = `It expires in <strong>${minutes} minute${minutes === 1 ? "" : "s"}</strong>.`;

    const name = firstName
        ? firstName.charAt(0).toUpperCase() + firstName.slice(1)
        : "there";

    return {
        to,
        from: FROM_EMAIL,
        subject,
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F0F4F8;font-family:'DM Sans',Arial,sans-serif">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)">
  <div style="background:#0D1B2A;padding:28px 36px 20px">
    <div style="font-weight:800;font-size:22px;color:#fff;letter-spacing:-0.5px">Dolluz Corp<span style="color:#E8520A">.</span></div>
    <div style="font-size:11px;color:#94A3B8;letter-spacing:2px;text-transform:uppercase;margin-top:4px">dAttendance Portal</div>
  </div>
  <div style="padding:32px 36px">
    <div style="font-size:15px;font-weight:700;color:#0D1B2A;margin-bottom:8px">${title}</div>
    <div style="font-size:13px;color:#64748B;margin-bottom:24px;line-height:1.6">Hi <strong>${name}</strong>,<br>${lead} ${expiry}</div>
    <div style="background:#F8FAFC;border:2px dashed #E8520A;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
      <div style="font-family:'Courier New',monospace;font-size:36px;font-weight:800;color:#E8520A;letter-spacing:10px">${otp}</div>
    </div>
    <div style="font-size:12px;color:#94A3B8;line-height:1.6">${warning}</div>
  </div>
  <div style="background:#F8FAFC;padding:16px 36px;text-align:center;font-size:11px;color:#94A3B8">${footerLine}<br>For any queries, please contact <a href="mailto:admin@dolluzcorp.com" style="color:#E8520A;text-decoration:none">admin@dolluzcorp.com</a></div>
</div></body></html>`,
    };
}

/**
 * Sends the code. Returns true when SendGrid accepted it.
 *
 * Without SENDGRID_API_KEY the code is logged instead of sent, so local
 * development works without live mail. That branch is refused in production -
 * silently printing sign-in codes to a server log would be a back door.
 */
// Every send is echoed to the terminal in the same shape dSlip uses, so one
// tail across the suite reads the same way.
//
// NOTE: this prints the code itself, in production as well as development.
// That is deliberate and matches dSlip, but it does mean anyone who can read
// the server log - pm2 logs, a shipped log file, a screen-share - can sign in
// as that employee for as long as the code lives.
function logMailSent(msg, args) {
    const label = args.purpose === "reset" ? "password reset" : "2FA sign-in";
    console.log(
        `✅ Mail sent [dAttendance ${label}]
` +
        `   From   : ${msg.from}
` +
        `   To     : ${msg.to}
` +
        `   Subject: ${msg.subject}
` +
        `   OTP    : ${args.otp}`
    );
}

async function sendOtpMail(args) {
    const msg = buildOtpMail(args);
    if (!process.env.SENDGRID_API_KEY) {
        if (process.env.NODE_ENV === "production") {
            console.error("[otp] SENDGRID_API_KEY missing in production - refusing to issue a code");
            return false;
        }
        // No key, so nothing was actually sent - do NOT print "Mail sent".
        console.warn(
            `⚠️  No SENDGRID_API_KEY - mail NOT sent [dAttendance ${args.purpose === "reset" ? "password reset" : "2FA sign-in"}]
` +
            `   To     : ${args.to}
` +
            `   Subject: ${msg.subject}
` +
            `   OTP    : ${args.otp}`
        );
        return true;
    }
    try {
        await sgMail.send(msg);
        logMailSent(msg, args);
        return true;
    } catch (err) {
        console.error("[otp] SendGrid failed:", err?.response?.body || err.message);
        return false;
    }
}

module.exports = {
    OTP_LENGTH,
    generateOtp,
    hashOtp,
    verifyOtp,
    deviceToken,
    sha256,
    maskEmail,
    buildOtpMail,
    sendOtpMail,
};
