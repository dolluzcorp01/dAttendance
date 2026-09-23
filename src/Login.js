// ============================================================================
//  dAttendance - sign in.
//
//  Same screen as the dAssure sign-in, so the two apps read as one product:
//  a navy banner on the left, a 520px form column on the right.
//
//  The left panel rotates through banners that dAdmin owns, from its global
//  Login Page Config. That read is unauthenticated, cross-origin and entirely
//  best-effort: FALLBACK_BANNERS is on screen from the first paint and stays
//  there if dAdmin is down, slow or has nothing configured. Nothing about
//  signing in waits on it.
//
//  The right column is a small state machine:
//
//    credentials ──password ok──> code ──verified──> /attendance
//         │                        ▲
//         │                        └── skipped when this browser is already
//         │                            trusted, which is what "Remember for N
//         │                            days" on the credentials screen buys -
//         │                            and skipped outright when dAdmin has
//         │                            two-step OFF for dAttendance.
//         │                            The tick rides along to /verify-otp,
//         │                            which is where trustDevice() runs.
//         └──"Forgot password"──> forgot-email → forgot-code → forgot-reset
//
//  Credentials belong to dAdmin. There is no separate account here and no
//  "sign up" - if someone cannot get in, they are fixed in dAdmin.
// ============================================================================
import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { FaEye, FaEyeSlash, FaExclamationTriangle } from "react-icons/fa";
import { apiJson, DADMIN_API_BASE } from "./utils/api";
import { useSession } from "./utils/SessionContext";
import dolluzEagle from "./assets/img/app_eagle.png";
import dolluzLockup from "./assets/img/app_lockup_reversed.png";
import dolluzWatermark from "./assets/img/app_eagle_watermark.png";
import "./Login.css";

// Must match this app's key in dAdmin's LOGIN_APPS exactly, case included.
const APP_KEY = "dAttendance";

// What the panel shows before the fetch resolves, and what it keeps showing if
// dAdmin is unreachable or has no banners configured for this app. Same field
// names as the API returns, so the render below never has to know which of the
// two it is holding. The gradient repeats Login.css's own panel default, so an
// offline sign-in looks exactly as it always did.
const FALLBACK_BANNERS = [
    {
        banner_id: "fallback-1",
        tag_label: "Attendance",
        headline: "Every day counts once",
        subline:
            "Working day, week-off or declared holiday - every date lands in exactly " +
            "one bucket, and the totals always reconcile.",
        gradient_from: "#0E1A2B",
        gradient_to: "#1E3350",
    },
];

// The figures under the rule. dAdmin owns them now (Login Page Config -> Panel
// figures); this is what shows until it answers, and what stays if it cannot be
// reached. Same values it is seeded with, so an offline sign-in is identical.
//
// Whatever dAdmin sends, these stay fixed product facts and never live counts:
// the sign-in screen is unauthenticated, so it must not report anything about
// employees, attendance or hours. value is a STRING - "24/7" and "100" both
// belong in that slot - and is rendered exactly as given.
const FALLBACK_STATS = [
    { value: "3", label: "work patterns" },
    { value: "2", label: "marks to set" },
    { value: "1", label: "sheet a month" },
];

const DEFAULT_ROTATE_SECONDS = 3;

// The field takes an employee ID or an email and the server matches on both.
// Upper-casing helps DZIND147 but mangles an address into TIGER@GMAIL.COM as
// you type, so anything with an @ is left alone. Matching is case-insensitive
// in MySQL either way - this is purely cosmetic.
const normaliseIdentifier = (v) => (v.includes("@") ? v : v.toUpperCase());

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Length of the emailed code, matching dAdmin. The server side is
// OTP_LENGTH in .env (default 6) - if that is ever changed, change this too,
// or the field will cut the code short and Verify will never enable.
const OTP_DIGITS = 6;

// "Change Password" in the top-nav dropdown lands here as /login?changePassword,
// the same entry point dSlip uses. dAttendance has no separate change-password
// screen: changing a password IS the reset flow - prove the mailbox with an
// emailed code, then set a new one - so the query param just opens it at step
// one instead of the sign-in form.
const wantsPasswordChange = () =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("changePassword");

export default function Login() {
    const [step, setStep] = useState(() => (wantsPasswordChange() ? "change-password" : "credentials"));

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

    // The old-password route to a new password. forgot-reset is shared between
    // the two routes, so it has to know which one it is finishing: the emailed
    // code spends a reset_token, this one re-sends the current password.
    const [oldPass, setOldPass] = useState("");
    const [showOld, setShowOld] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    // Caps Lock is the single most common reason a correct password is typed
    // wrong. One flag for the whole page: only one password field is ever on
    // screen at a time.
    const [capsOn, setCapsOn] = useState(false);
    const [resetVia, setResetVia] = useState("otp");   // "otp" | "current" 

    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    // Separate from `busy` so the resend link can say "Sending…" without the
    // Verify button also going into its own pending state.
    const [resending, setResending] = useState(false);

    // ── the left panel's carousel ─────────────────────────────────────────
    const [panels, setPanels] = useState(FALLBACK_BANNERS);
    const [slide, setSlide] = useState(0);
    const [rotateSecs, setRotateSecs] = useState(DEFAULT_ROTATE_SECONDS);
    const [panelStats, setPanelStats] = useState(FALLBACK_STATS);
    const [paused, setPaused] = useState(false);

    // How long a remembered browser stays remembered. att_config owns it and
    // /login echoes it back as remember_days; 14 is only what we say until it
    // answers, so an admin changing the setting cannot leave the copy lying.
    const [rememberDays, setRememberDays] = useState(14);
    // Whether dAdmin has two-step on for this app. Starts ON, so a slow or
    // failed fetch never hides "remember" while the server still wants a code.
    // The server enforces the switch either way; this only decides what to offer.
    const [twoStepOn, setTwoStepOn] = useState(true);

    const navigate = useNavigate();
    const { employee, ready, refetch } = useSession();

    // Already signed in (e.g. arrived from Inside D with a live cookie).
    // NOT when they came here to change their password: that link is reached
    // FROM the app while signed in, so bouncing them back would make the menu
    // item do nothing.
    useEffect(() => {
        if (ready && employee && !wantsPasswordChange()) navigate("/attendance", { replace: true });
    }, [ready, employee, navigate]);

    // Sent here because an administrator ended the session in dAdmin - api.js
    // turns a 401 SESSION_REVOKED into /login?revoked=1. Say so: a bare form
    // with no explanation reads as a bug rather than something done on
    // purpose. Inline, like every other message on this page - not a toast.
    useEffect(() => {
        if (new URLSearchParams(window.location.search).has("revoked")) {
            setNotice("An administrator ended your session. Sign in again to continue.");
        }
    }, []);

    // dAdmin's Login Page Config. Best-effort by design: the endpoint answers
    // 200 even when dAdmin's own database is down, and anything short of a
    // non-empty banner list leaves FALLBACK_BANNERS exactly where it is. An
    // app with none configured must keep the fallback, not go blank.
    useEffect(() => {
        let live = true;
        fetch(`${DADMIN_API_BASE}/api/login-banners/public?app=${encodeURIComponent(APP_KEY)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (!live || !data) return;
                if (Array.isArray(data.banners) && data.banners.length) {
                    setPanels(data.banners);
                    setSlide(0);
                }
                if (data.rotate_seconds) setRotateSecs(data.rotate_seconds);
                // An empty array is a real answer - "this app shows no
                // figures" - so only a missing key falls back. Note this is a
                // different rule from banners above, where empty MUST fall back
                // or the panel would go blank.
                if (Array.isArray(data.panel_stats)) setPanelStats(data.panel_stats);
                // Whether to offer "remember me" at all. dAdmin owns this; the
                // server enforces it regardless of what this screen shows.
                // trust_days also means the label is right before the first
                // /login, instead of saying 14 until the server answers.
                setTwoStepOn(Number(data.two_factor_enabled) !== 0);
                if (data.trust_days) setRememberDays(data.trust_days);
            })
            .catch(() => { /* FALLBACK_BANNERS is already on screen */ });
        return () => { live = false; };
    }, []);

    // A single banner has nothing to rotate to - advancing it to itself would
    // just restart the transition for no reason - so no timer is started.
    useEffect(() => {
        if (panels.length < 2 || paused) return undefined;
        const ms = Math.max(2, rotateSecs) * 1000;
        const t = setInterval(() => setSlide((i) => (i + 1) % panels.length), ms);
        return () => clearInterval(t);
    }, [panels.length, rotateSecs, paused]);

    // A stale /login?changePassword link opened while signed OUT cannot use the
    // old-password route - both its endpoints are behind verifyJWT, so Continue
    // would just 401. The emailed-code flow needs no session and reaches the
    // same place, so send them there rather than to a screen that cannot work.
    useEffect(() => {
        if (!ready || employee) return;
        setStep((cur) => {
            if (cur !== "change-password") return cur;
            setNotice("Sign in first, or change your password with an emailed code.");
            return "forgot-email";
        });
    }, [ready, employee]);

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
        // Only /login sends this; the reset flow's responses do not, and must
        // not reset it to a guess.
        if (res.remember_days) setRememberDays(res.remember_days);
        setSentTo(res.sent_to || "");
        setExpiresIn(res.expires_in || 120);
        setResendIn(res.resend_after || 30);
        setOtp("");
        setError("");
        setStep(nextStep);
    }, []);

    // getModifierState is missing on synthetic events in some environments,
    // so this must never assume it is there.
    const onPasswordKey = (e) => {
        if (typeof e.getModifierState === "function") setCapsOn(e.getModifierState("CapsLock"));
    };

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
                body: JSON.stringify({ emp_id: empId.trim(), password, remember: twoStepOn && remember }),
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
        if (otp.length < OTP_DIGITS) { setError("Enter the code from your email."); return; }
        setBusy(true); setError("");
        try {
            const res = await apiJson("/api/auth/verify-otp", {
                method: "POST",
                body: JSON.stringify({ challenge, otp, remember }),
            });
            await refetch();
            // Signing in previously jumped straight to /attendance, so the one
            // fact worth telling - that this browser will not be asked again,
            // and for how long - was never said anywhere. dAdmin holds its own
            // confirmation for 1200ms before redirecting; this matches that,
            // and only on the success path.
            setNotice(res.remembered
                ? `Signed in. You will not be asked for a code on this browser for ${rememberDays} day${rememberDays === 1 ? "" : "s"}.`
                : "Signed in. Taking you to your attendance sheet…");
            setTimeout(() => navigate("/attendance", { replace: true }), 1200);
        } catch (err) {
            setError(err.message || "That code is not valid or has expired.");
            setOtp("");
            setBusy(false);
        }
        // NOT in a finally: on success the button must stay disabled through
        // the 1200ms, or the code could be submitted a second time.
    };

    const resend = async () => {
        if (resending) return;
        setResending(true); setError(""); setNotice("");
        try {
            const res = await apiJson("/api/auth/resend-otp", {
                method: "POST",
                body: JSON.stringify({ challenge }),
            });
            setChallenge(res.challenge);
            setExpiresIn(res.expires_in || 120);
            setResendIn(res.resend_after || 30);
            setOtp("");
            // Naming the mailbox is the point of the message: it confirms
            // WHERE to look, which "a new code is on its way" alone does not.
            setNotice(`A new code is on its way to ${sentTo}.`);
        } catch (err) {
            setError(err.message || "Could not send another code.");
        } finally { setResending(false); }
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
        if (otp.length < OTP_DIGITS) { setError("Enter the code from your email."); return; }
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

    // Advances a screen and nothing more. The server grants nothing here and
    // POST /change-password checks the same password again before it writes, so
    // skipping or forging this step buys nobody anything.
    const verifyOldPassword = async () => {
        if (!oldPass) { setError("Enter your current password."); return; }
        setBusy(true); setError(""); setNotice("");
        try {
            await apiJson("/api/auth/change-password/verify", {
                method: "POST",
                body: JSON.stringify({ current: oldPass }),
            });
            setResetVia("current");
            setNewPass(""); setConfirmPass("");
            setStep("forgot-reset");
        } catch (err) {
            setError(err.message || "That password is not correct.");
        } finally { setBusy(false); }
    };

    const submitNewPassword = async () => {
        if (newPass !== confirmPass) { setError("The two passwords do not match."); return; }
        setBusy(true); setError("");
        try {
            await apiJson(
                resetVia === "current" ? "/api/auth/change-password" : "/api/auth/forgot/reset",
                {
                    method: "POST",
                    body: JSON.stringify(resetVia === "current"
                        ? { current: oldPass, password: newPass, confirm: confirmPass }
                        : { reset_token: resetToken, password: newPass, confirm: confirmPass }),
                });
            // Reached from the app while signed in (/login?changePassword), the
            // old session would otherwise carry on under the old password. End
            // it, so "sign in with your new password" is actually true.
            if (employee) {
                try { await apiJson("/api/auth/logout", { method: "POST", body: "{}" }); } catch { /* ignore */ }
                await refetch();
            }
            setStep("credentials");
            setPassword(""); setNewPass(""); setConfirmPass(""); setOldPass("");
            setResetToken(null); setChallenge(null); setResetVia("otp");
            setError("");
            setNotice("Password changed. Sign in with your new password.");
        } catch (err) {
            setError(err.message || "Could not change the password.");
        } finally { setBusy(false); }
    };

    // ── render ────────────────────────────────────────────────────────────
    // panels is never set to an empty array, but a banner is read on every
    // paint - falling back here costs nothing and cannot throw.
    const banner = panels[slide] || panels[0] || FALLBACK_BANNERS[0];

    // A banner configured with an image is image-ONLY: its text columns may
    // still hold whatever copy it had before the picture was attached, and none
    // of it gets painted over the photograph.
    //
    // The file belongs to dAdmin, so it is resolved against DADMIN_API_BASE.
    // API_BASE is this app's own server on 4010 and has no such file - that
    // mistake costs a silent 404 and a blank panel. <img> and background-image
    // are not CORS-gated for display, so nothing else is needed.
    const bannerImg = banner.image_path ? `${DADMIN_API_BASE}${banner.image_path}` : null;

    return (
        <div className="dzs-root">
            <section
                className={`dzs-panel${bannerImg ? " dzs-panel--img" : ""}`}
                style={bannerImg
                    ? { backgroundImage: `url("${bannerImg}")` }
                    : { background: `linear-gradient(140deg, ${banner.gradient_from} 0%, ${banner.gradient_to} 100%)` }}
                onMouseEnter={() => setPaused(true)}
                onMouseLeave={() => setPaused(false)}
            >
                {/* Everything in here is chrome that belongs to a gradient
                    banner. On an image banner the picture IS the panel, so none
                    of it renders - there is nothing sitting over the photo to
                    fight with it. The indicator below stays either way: it is
                    the navigation, and a carousel without it cannot be used. */}
                {!bannerImg && (
                    <>
                        <img className="dzs-watermark" src={dolluzWatermark} alt="" aria-hidden="true" />
                        <svg className="dzs-rings" viewBox="0 0 600 600" aria-hidden="true" focusable="false">
                            {[0, 1, 2, 3, 4, 5].map((n) => (
                                <circle key={n} cx="300" cy="300" r={60 + n * 48}
                                        fill="none" stroke="#fff" strokeWidth="1.4" />
                            ))}
                        </svg>

                        {/* The corporate lockup with the tagline, not the app one.
                            The banner speaks for Dolluz Corp; the app names itself
                            on the form side. */}
                        <img className="dzs-panel-logo" src={dolluzLockup} alt="Dolluz Corp - One Place . One Start . One Team" />

                        <div className="dzs-banner">
                            <span className="dzs-tag">{banner.tag_label}</span>
                            <h1 className="dzs-headline">{banner.headline}</h1>
                            <p className="dzs-subline">{banner.subline}</p>
                            <div className="dzs-rule" />
                            {/* Fixed product facts, not the rotating copy - see
                                FALLBACK_STATS. Cleared in dAdmin the row goes
                                entirely: an empty flex row would still hold open
                                blank space under the rule. Keyed by index because
                                the labels are admin-editable text and two could
                                legitimately read the same. */}
                            {panelStats.length > 0 && (
                                <div className="dzs-stats">
                                    {panelStats.map((st, i) => (
                                        <div className="dzs-stat" key={i}>
                                            <div className="dzs-stat-value">{st.value}</div>
                                            <div className="dzs-stat-label">{st.label}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* One bar per banner, and they jump. No "rotating every N
                    seconds" caption: that is internal detail to whoever is
                    signing in. */}
                {panels.length > 1 && (
                    <div className="dzs-indicator">
                        {panels.map((b, i) => (
                            <button
                                key={b.banner_id ?? i}
                                type="button"
                                className={`dzs-bar${i === slide ? " is-active" : ""}`}
                                aria-label={`Show banner ${i + 1} of ${panels.length}`}
                                aria-current={i === slide}
                                onClick={() => setSlide(i)}
                            />
                        ))}
                    </div>
                )}
            </section>

            <section className="dzs-form">
                <Lockup sm />

                {step === "credentials" && (
                    <>
                        <h2 className="dzs-title">Sign in</h2>
                        <p className="dzs-sub">
                            Your Dolluz employee ID and password - the same credentials as Inside D.
                        </p>

                        <Field label="Work email" id="empId">
                            <input
                                id="empId" className="dzs-input" value={empId} autoComplete="username"
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
                                    onKeyUp={onPasswordKey}
                                    onBlur={() => setCapsOn(false)}
                                    onKeyDown={(e) => e.key === "Enter" && submitCredentials()}
                                />
                            </Reveal>
                            <CapsHint on={capsOn} />
                        </Field>

                        <div className="dzs-options">
                            {/* Nothing to remember when there is no code to skip. */}
                            {twoStepOn && (
                                <label className="dzs-remember">
                                    <input type="checkbox" checked={remember}
                                           onChange={(e) => setRemember(e.target.checked)} />
                                    Remember for {rememberDays} day{rememberDays === 1 ? "" : "s"}
                                </label>
                            )}
                            <button type="button" className="dzs-link"
                                    onClick={() => { setError(""); setNotice(""); setForgotId(empId); setStep("forgot-email"); }}>
                                Forgot password
                            </button>
                        </div>

                        <Messages error={error} notice={notice} />

                        <button type="button" className="dzs-submit" disabled={busy} onClick={submitCredentials}>
                            {busy ? "Checking…" : "Sign in"}
                        </button>

                        {twoStepOn && (
                            <p className="dzs-foot">
                                Ticking <strong>Remember for {rememberDays} day{rememberDays === 1 ? "" : "s"}</strong> skips the emailed
                                code on this browser only. Everywhere else, signing in always asks for one.
                            </p>
                        )}
                    </>
                )}

                {(step === "code" || step === "forgot-code") && (
                    <>
                        <h2 className="dzs-title">Enter the code</h2>
                        <p className="dzs-sub">
                            We sent a 6-digit code to <strong>{sentTo}</strong>.{" "}
                            {expiresIn > 0
                                ? <>It expires in <strong className="dzs-count">{mmss(expiresIn)}</strong>.</>
                                : <>That code has expired - send a new one.</>}
                        </p>

                        <Field label="Verification code" id="otp">
                            <input
                                id="otp" className="dzs-input dzs-otp" value={otp}
                                inputMode="numeric" autoComplete="one-time-code" maxLength={OTP_DIGITS}
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
                            <button type="button" className="dzs-link"
                                    disabled={busy || resending || resendIn > 0} onClick={resend}>
                                {resending ? "Sending…" : resendIn > 0 ? `Resend in ${resendIn}s` : "Send a new code"}
                            </button>
                        </div>

                        <Messages error={error} notice={notice} />

                        <button type="button" className="dzs-submit"
                                disabled={busy || expiresIn === 0 || otp.length < OTP_DIGITS}
                                onClick={step === "code" ? submitCode : verifyForgotCode}>
                            {busy ? "Verifying…" : step === "code" ? "Verify and sign in" : "Verify code"}
                        </button>

                        <p className="dzs-foot">
                            Didn’t get it? Check your spam folder. The code is only valid for a
                            couple of minutes. Never share it with anyone.
                        </p>
                    </>
                )}

                {step === "change-password" && (
                    <>
                        <h2 className="dzs-title">Change password</h2>
                        <p className="dzs-sub">Enter your current password to continue.</p>

                        <Field label="Old password" id="oldpw">
                            <Reveal shown={showOld} onToggle={() => setShowOld((v) => !v)}>
                                <input
                                    id="oldpw" className="dzs-input" value={oldPass}
                                    type={showOld ? "text" : "password"} autoComplete="current-password" autoFocus
                                    onChange={(e) => { setOldPass(e.target.value); setError(""); }}
                                    onKeyUp={onPasswordKey}
                                    onBlur={() => setCapsOn(false)}
                                    onKeyDown={(e) => e.key === "Enter" && verifyOldPassword()}
                                />
                            </Reveal>
                            <CapsHint on={capsOn} />
                        </Field>

                        <Messages error={error} notice={notice} />

                        <button type="button" className="dzs-submit" disabled={busy || !oldPass}
                                onClick={verifyOldPassword}>
                            {busy ? "Checking…" : "Continue"}
                        </button>

                        {/* Don't know it? The emailed-code route reaches the same
                            new-password screen without needing the old one. */}
                        <div className="dzs-options dzs-options-foot">
                            <button type="button" className="dzs-link dzs-link-quiet"
                                    onClick={() => { setError(""); setNotice(""); setForgotId(empId); setStep("credentials"); }}>
                                ← Back to sign in
                            </button>
                            <button type="button" className="dzs-link"
                                    onClick={() => {
                                        setError(""); setNotice(""); setOldPass("");
                                        setResetVia("otp"); setStep("forgot-email");
                                    }}>
                                Change password via OTP
                            </button>
                        </div>
                    </>
                )}

                {step === "forgot-email" && (
                    <>
                        <h2 className="dzs-title">Reset password</h2>
                        <p className="dzs-sub">
                            Tell us who you are and we’ll email a code to the address on your
                            employee record.
                        </p>

                        <Field label="Work email" id="forgotId">
                            <input
                                id="forgotId" className="dzs-input" value={forgotId} autoComplete="username"
                                autoFocus
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
                                    onKeyUp={onPasswordKey}
                                    onBlur={() => setCapsOn(false)}
                                />
                            </Reveal>
                            <CapsHint on={capsOn} />
                        </Field>

                        {/* This field had no eye of its own - it followed the one
                            above it. Confirming a password you cannot see is
                            exactly the case the toggle exists for, so it gets
                            its own, as dAdmin's confirm field does. */}
                        <Field label="Confirm new password" id="cp">
                            <Reveal shown={showConfirm} onToggle={() => setShowConfirm((v) => !v)}>
                                <input
                                    id="cp" className="dzs-input" value={confirmPass}
                                    type={showConfirm ? "text" : "password"} autoComplete="new-password"
                                    onChange={(e) => { setConfirmPass(e.target.value); setError(""); }}
                                    onKeyUp={onPasswordKey}
                                    onBlur={() => setCapsOn(false)}
                                    onKeyDown={(e) => e.key === "Enter" && submitNewPassword()}
                                />
                            </Reveal>
                            <CapsHint on={capsOn} />
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
                            updates it everywhere in the suite - the account lives in dAdmin.
                        </p>
                    </>
                )}

                {/* One contact line for the whole column, so it is present on
                    every step rather than only the sign-in one. Same offer
                    dAdmin makes, and the only route out when somebody is locked
                    out of the mailbox the codes go to. */}
                <div className="dzs-support">
                    Trouble signing in? Contact{" "}
                    <a href="mailto:admin@dolluzcorp.com">admin@dolluzcorp.com</a>
                </div>
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

// Shown under whichever password field is on screen. Not an error - the
// password may well be correct - so it takes the hint styling, not the alert's.
function CapsHint({ on }) {
    if (!on) return null;
    return (
        <span className="dzs-field-note dzs-caps">
            <FaExclamationTriangle aria-hidden="true" /> Caps Lock is on
        </span>
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
