// ============================================================================
//  dAttendance - sign in.
//
//  Same screen as the dAssure sign-in, so the two apps read as one product:
//  a fixed navy banner on the left, a 520px form column on the right.
//  The left panel is STATIC markup - no carousel, no timers, no banner API.
//
//  The right column is a small state machine:
//
//    credentials ──password ok──> code ──verified──> /attendance
//         │                        ▲
//         │                        └── skipped when this browser is already
//         │                            trusted ("Remember for 14 days")
//         └──"Forgot password"──> forgot-email → forgot-code → forgot-reset
//
//  Credentials belong to dAdmin. There is no separate account here and no
//  "sign up" - if someone cannot get in, they are fixed in dAdmin.
// ============================================================================
import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { FaEye, FaEyeSlash } from "react-icons/fa";
import { apiJson } from "./utils/api";
import { useSession } from "./utils/SessionContext";
import dolluzEagle from "./assets/img/app_eagle.png";
import dolluzLockup from "./assets/img/app_lockup_reversed.png";
import dolluzWatermark from "./assets/img/app_eagle_watermark.png";
import "./Login.css";

const BANNER = {
    tag: "Attendance",
    headline: "Every day counts once",
    subline:
        "Working day, week-off or declared holiday — every date lands in exactly " +
        "one bucket, and the totals always reconcile.",
    stats: [
        { value: "3", label: "work patterns" },
        { value: "2", label: "marks to set" },
        { value: "1", label: "sheet a month" },
    ],
};

// The field takes an employee ID or an email and the server matches on both.
// Upper-casing helps DZIND147 but mangles an address into TIGER@GMAIL.COM as
// you type, so anything with an @ is left alone. Matching is case-insensitive
// in MySQL either way - this is purely cosmetic.
const normaliseIdentifier = (v) => (v.includes("@") ? v : v.toUpperCase());

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// "Change Password" in the top-nav dropdown lands here as /login?changePassword,
// the same entry point dSlip uses. dAttendance has no separate change-password
// screen: changing a password IS the reset flow - prove the mailbox with an
// emailed code, then set a new one - so the query param just opens it at step
// one instead of the sign-in form.
const wantsPasswordChange = () =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("changePassword");

export default function Login() {
    const [step, setStep] = useState(() => (wantsPasswordChange() ? "forgot-email" : "credentials"));

    const [empId, setEmpId] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [remember, setRemember] = useState(false);

    // The live OTP challenge, for whichever flow is running.
    const [otp, setOtp] = useState("");
    const [challenge, setChallenge] = useState(null);
    const [sentTo, setSentTo] = useState("");
    const [expiresIn, setExpiresIn] = useState(0);
    const [resendIn, setResendIn] = useState(0);

    // Password reset
    const [forgotId, setForgotId] = useState("");
    const [resetToken, setResetToken] = useState(null);
    const [newPass, setNewPass] = useState("");
    const [confirmPass, setConfirmPass] = useState("");
    const [showNew, setShowNew] = useState(false);

    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);

    const navigate = useNavigate();
    const { employee, ready, refetch } = useSession();

    // Already signed in (e.g. arrived from Inside D with a live cookie).
    // NOT when they came here to change their password: that link is reached
    // FROM the app while signed in, so bouncing them back would make the menu
    // item do nothing.
    useEffect(() => {
        if (ready && employee && !wantsPasswordChange()) navigate("/attendance", { replace: true });
    }, [ready, employee, navigate]);

    // ── the two countdowns ────────────────────────────────────────────────
    useEffect(() => {
        if (expiresIn <= 0) return undefined;
        const t = setInterval(() => setExpiresIn((s) => Math.max(0, s - 1)), 1000);
        return () => clearInterval(t);
    }, [expiresIn]);

    useEffect(() => {
        if (resendIn <= 0) return undefined;
        const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
        return () => clearInterval(t);
    }, [resendIn]);

    const startChallenge = useCallback((res, nextStep) => {
        setChallenge(res.challenge);
        setSentTo(res.sent_to || "");
        setExpiresIn(res.expires_in || 120);
        setResendIn(res.resend_after || 30);
        setOtp("");
        setError("");
        setStep(nextStep);
    }, []);

    const backToCredentials = () => {
        setStep("credentials");
        setChallenge(null); setOtp(""); setError(""); setNotice("");
        setExpiresIn(0); setResendIn(0);
    };

    // ── step 1: password ──────────────────────────────────────────────────
    const submitCredentials = async () => {
        if (!empId.trim() || !password) {
            setError("Enter your employee ID and password.");
            return;
        }
        setBusy(true); setError(""); setNotice("");
        try {
            const res = await apiJson("/api/auth/login", {
                method: "POST",
                body: JSON.stringify({ emp_id: empId.trim(), password, remember }),
            });
            if (res.otpRequired === false) {
                // A trusted browser. No code needed.
                await refetch();
                navigate("/attendance", { replace: true });
                return;
            }
            startChallenge(res, "code");
        } catch (err) {
            setError(err.message || "Invalid credentials");
        } finally { setBusy(false); }
    };

    // ── step 2: the sign-in code ──────────────────────────────────────────
    const submitCode = async () => {
        if (otp.length < 4) { setError("Enter the code from your email."); return; }
        setBusy(true); setError("");
        try {
            await apiJson("/api/auth/verify-otp", {
                method: "POST",
                body: JSON.stringify({ challenge, otp, remember }),
            });
            await refetch();
            navigate("/attendance", { replace: true });
        } catch (err) {
            setError(err.message || "That code is not valid or has expired.");
            setOtp("");
        } finally { setBusy(false); }
    };

    const resend = async () => {
        setBusy(true); setError(""); setNotice("");
        try {
            const res = await apiJson("/api/auth/resend-otp", {
                method: "POST",
                body: JSON.stringify({ challenge }),
            });
            setChallenge(res.challenge);
            setExpiresIn(res.expires_in || 120);
            setResendIn(res.resend_after || 30);
            setOtp("");
            setNotice("A new code is on its way.");
        } catch (err) {
            setError(err.message || "Could not send another code.");
        } finally { setBusy(false); }
    };

    // ── password reset ────────────────────────────────────────────────────
    const startForgot = async () => {
        if (!forgotId.trim()) { setError("Enter your employee ID or work email."); return; }
        setBusy(true); setError(""); setNotice("");
        try {
            const res = await apiJson("/api/auth/forgot/start", {
                method: "POST",
                body: JSON.stringify({ email: forgotId.trim() }),
            });
            startChallenge(res, "forgot-code");
        } catch (err) {
            setError(err.message || "Could not send a code.");
        } finally { setBusy(false); }
    };

    const verifyForgotCode = async () => {
        if (otp.length < 4) { setError("Enter the code from your email."); return; }
        setBusy(true); setError("");
        try {
            const res = await apiJson("/api/auth/forgot/verify", {
                method: "POST",
                body: JSON.stringify({ challenge, otp }),
            });
            setResetToken(res.reset_token);
            setNewPass(""); setConfirmPass(""); setNotice("");
            setStep("forgot-reset");
        } catch (err) {
            setError(err.message || "That code is not valid or has expired.");
            setOtp("");
        } finally { setBusy(false); }
    };

    const submitNewPassword = async () => {
        if (newPass !== confirmPass) { setError("The two passwords do not match."); return; }
        setBusy(true); setError("");
        try {
            await apiJson("/api/auth/forgot/reset", {
                method: "POST",
                body: JSON.stringify({ reset_token: resetToken, password: newPass, confirm: confirmPass }),
            });
            // Reached from the app while signed in (/login?changePassword), the
            // old session would otherwise carry on under the old password. End
            // it, so "sign in with your new password" is actually true.
            if (employee) {
                try { await apiJson("/api/auth/logout", { method: "POST", body: "{}" }); } catch { /* ignore */ }
                await refetch();
            }
            setStep("credentials");
            setPassword(""); setNewPass(""); setConfirmPass("");
            setResetToken(null); setChallenge(null);
            setError("");
            setNotice("Password changed. Sign in with your new password.");
        } catch (err) {
            setError(err.message || "Could not change the password.");
        } finally { setBusy(false); }
    };

    // ── render ────────────────────────────────────────────────────────────
    return (
        <div className="dzs-root">
            <section className="dzs-panel">
                <img className="dzs-watermark" src={dolluzWatermark} alt="" aria-hidden="true" />
                <svg className="dzs-rings" viewBox="0 0 600 600" aria-hidden="true" focusable="false">
                    {[0, 1, 2, 3, 4, 5].map((n) => (
                        <circle key={n} cx="300" cy="300" r={60 + n * 48}
                                fill="none" stroke="#fff" strokeWidth="1.4" />
                    ))}
                </svg>

                {/* The corporate lockup with the tagline, not the app one. The
                    banner speaks for Dolluz Corp; the app names itself on the
                    form side. */}
                <img className="dzs-panel-logo" src={dolluzLockup} alt="Dolluz Corp — One Place . One Start . One Team" />

                <div className="dzs-banner">
                    <span className="dzs-tag">{BANNER.tag}</span>
                    <h1 className="dzs-headline">{BANNER.headline}</h1>
                    <p className="dzs-subline">{BANNER.subline}</p>
                    <div className="dzs-rule" />
                    <div className="dzs-stats">
                        {BANNER.stats.map((s) => (
                            <div className="dzs-stat" key={s.label}>
                                <div className="dzs-stat-value">{s.value}</div>
                                <div className="dzs-stat-label">{s.label}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="dzs-indicator" aria-hidden="true">
                    <span className="dzs-bar is-active" />
                    <span className="dzs-bar" />
                    <span className="dzs-bar" />
                </div>
            </section>

            <section className="dzs-form">
                <Lockup sm />

                {step === "credentials" && (
                    <>
                        <h2 className="dzs-title">Sign in</h2>
                        <p className="dzs-sub">
                            Your Dolluz employee ID and password — the same credentials as Inside D.
                        </p>

                        <Field label="Employee ID or work email" id="empId">
                            <input
                                id="empId" className="dzs-input" value={empId} autoComplete="username"
                                placeholder="DZIND000"
                                onChange={(e) => { setEmpId(normaliseIdentifier(e.target.value)); setError(""); }}
                                onKeyDown={(e) => e.key === "Enter" && submitCredentials()}
                            />
                        </Field>

                        <Field label="Password" id="pw">
                            <Reveal shown={showPassword} onToggle={() => setShowPassword((v) => !v)}>
                                <input
                                    id="pw" className="dzs-input" value={password}
                                    type={showPassword ? "text" : "password"} autoComplete="current-password"
                                    onChange={(e) => { setPassword(e.target.value); setError(""); }}
                                    onKeyDown={(e) => e.key === "Enter" && submitCredentials()}
                                />
                            </Reveal>
                        </Field>

                        <div className="dzs-options">
                            <label className="dzs-remember">
                                <input type="checkbox" checked={remember}
                                       onChange={(e) => setRemember(e.target.checked)} />
                                Remember for 14 days
                            </label>
                            <button type="button" className="dzs-link"
                                    onClick={() => { setError(""); setNotice(""); setForgotId(empId); setStep("forgot-email"); }}>
                                Forgot password
                            </button>
                        </div>

                        <Messages error={error} notice={notice} />

                        <button type="button" className="dzs-submit" disabled={busy} onClick={submitCredentials}>
                            {busy ? "Checking…" : "Sign in"}
                        </button>

                        <p className="dzs-foot">
                            Ticking <strong>Remember for 14 days</strong> skips the emailed code on this
                            browser only. Everywhere else, signing in always asks for one.
                        </p>
                    </>
                )}

                {(step === "code" || step === "forgot-code") && (
                    <>
                        <h2 className="dzs-title">Enter the code</h2>
                        <p className="dzs-sub">
                            We sent a 6-digit code to <strong>{sentTo}</strong>.{" "}
                            {expiresIn > 0
                                ? <>It expires in <strong className="dzs-count">{mmss(expiresIn)}</strong>.</>
                                : <>That code has expired — send a new one.</>}
                        </p>

                        <Field label="Verification code" id="otp">
                            <input
                                id="otp" className="dzs-input dzs-otp" value={otp}
                                inputMode="numeric" autoComplete="one-time-code" maxLength={8}
                                placeholder="••••••" autoFocus
                                onChange={(e) => { setOtp(e.target.value.replace(/\D/g, "")); setError(""); }}
                                onKeyDown={(e) => e.key === "Enter" &&
                                    (step === "code" ? submitCode() : verifyForgotCode())}
                            />
                        </Field>

                        <div className="dzs-options">
                            <button type="button" className="dzs-link dzs-link-quiet" onClick={backToCredentials}>
                                ← Back
                            </button>
                            <button type="button" className="dzs-link" disabled={busy || resendIn > 0} onClick={resend}>
                                {resendIn > 0 ? `Resend in ${resendIn}s` : "Send a new code"}
                            </button>
                        </div>

                        <Messages error={error} notice={notice} />

                        <button type="button" className="dzs-submit"
                                disabled={busy || expiresIn === 0 || otp.length < 4}
                                onClick={step === "code" ? submitCode : verifyForgotCode}>
                            {busy ? "Verifying…" : step === "code" ? "Verify and sign in" : "Verify code"}
                        </button>

                        <p className="dzs-foot">
                            Didn’t get it? Check your spam folder. The code is only valid for a
                            couple of minutes, and never ask anyone to read it to them.
                        </p>
                    </>
                )}

                {step === "forgot-email" && (
                    <>
                        <h2 className="dzs-title">Reset password</h2>
                        <p className="dzs-sub">
                            Tell us who you are and we’ll email a code to the address on your
                            employee record.
                        </p>

                        <Field label="Employee ID or work email" id="forgotId">
                            <input
                                id="forgotId" className="dzs-input" value={forgotId} autoComplete="username"
                                placeholder="DZIND000" autoFocus
                                onChange={(e) => { setForgotId(normaliseIdentifier(e.target.value)); setError(""); }}
                                onKeyDown={(e) => e.key === "Enter" && startForgot()}
                            />
                        </Field>

                        <div className="dzs-options">
                            <button type="button" className="dzs-link dzs-link-quiet" onClick={backToCredentials}>
                                ← Back to sign in
                            </button>
                        </div>

                        <Messages error={error} notice={notice} />

                        <button type="button" className="dzs-submit" disabled={busy} onClick={startForgot}>
                            {busy ? "Sending…" : "Send code"}
                        </button>

                        <p className="dzs-foot">
                            The code goes to the work address held in dAdmin, not one you type here.
                        </p>
                    </>
                )}

                {step === "forgot-reset" && (
                    <>
                        <h2 className="dzs-title">New password</h2>
                        <p className="dzs-sub">
                            At least 8 characters, with a letter and a number.
                        </p>

                        <Field label="New password" id="np">
                            <Reveal shown={showNew} onToggle={() => setShowNew((v) => !v)}>
                                <input
                                    id="np" className="dzs-input" value={newPass}
                                    type={showNew ? "text" : "password"} autoComplete="new-password" autoFocus
                                    onChange={(e) => { setNewPass(e.target.value); setError(""); }}
                                />
                            </Reveal>
                        </Field>

                        <Field label="Confirm new password" id="cp">
                            <input
                                id="cp" className="dzs-input" value={confirmPass}
                                type={showNew ? "text" : "password"} autoComplete="new-password"
                                onChange={(e) => { setConfirmPass(e.target.value); setError(""); }}
                                onKeyDown={(e) => e.key === "Enter" && submitNewPassword()}
                            />
                            {confirmPass && newPass !== confirmPass && (
                                <span className="dzs-field-note">The two passwords do not match.</span>
                            )}
                        </Field>

                        <Messages error={error} notice={notice} />

                        <button type="button" className="dzs-submit"
                                disabled={busy || !newPass || newPass !== confirmPass}
                                onClick={submitNewPassword}>
                            {busy ? "Saving…" : "Change password"}
                        </button>

                        <p className="dzs-foot">
                            Changing your password signs out every browser you had remembered, and
                            updates it everywhere in the suite — the account lives in dAdmin.
                        </p>
                    </>
                )}
            </section>
        </div>
    );
}

// ---------------------------------------------------------------------------
function Field({ label, id, children }) {
    return (
        <div className="dzs-field">
            <label className="dzs-label" htmlFor={id}>{label}</label>
            {children}
        </div>
    );
}

function Reveal({ shown, onToggle, children }) {
    return (
        <div className="dzs-reveal-wrap">
            {children}
            <button
                type="button" className="dzs-reveal" tabIndex={-1}
                aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown}
                onClick={onToggle}
            >
                {shown ? <FaEyeSlash /> : <FaEye />}
            </button>
        </div>
    );
}

function Messages({ error, notice }) {
    return (
        <>
            {error && <div className="dzs-alert" role="alert">{error}</div>}
            {notice && !error && <div className="dzs-hint">{notice}</div>}
        </>
    );
}

// ---------------------------------------------------------------------------
//  The lockup: eagle beside a two-line wordmark, naming the app rather than
//  the company. Used on the form side only - the banner carries the corporate
//  lockup image instead.
//    sm - the .86 scale used above the form
// ---------------------------------------------------------------------------
function Lockup({ sm }) {
    return (
        <div className={`dzs-lockup${sm ? " sm" : ""}`}>
            <img src={dolluzEagle} alt="Dolluz Corp" />
            <div>
                <div className="dzs-lockup-name">DOLLUZ CORP</div>
                <div className="dzs-lockup-sub">dAttendance</div>
            </div>
        </div>
    );
}
