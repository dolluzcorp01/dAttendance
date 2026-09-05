// ============================================================================
//  dAttendance - sign in.
//
//  Same screen as the dAssure sign-in, so the two apps read as one product:
//  a fixed navy banner on the left, a 520px form column on the right.
//
//  The left panel is STATIC markup. No carousel, no timers, no banner API -
//  the copy is hard-coded below and never changes.
//
//  Credentials belong to dAdmin. There is no separate account here and no
//  "sign up" - if someone cannot get in, they are fixed in dAdmin.
// ============================================================================
import React, { useState, useEffect } from "react";
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

export default function Login() {
    const [empId, setEmpId] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState("");
    const [hint, setHint] = useState("");
    const [busy, setBusy] = useState(false);
    const navigate = useNavigate();
    const { employee, ready, refetch } = useSession();

    // Already signed in (e.g. arrived from Inside D with a live cookie).
    useEffect(() => {
        if (ready && employee) navigate("/attendance", { replace: true });
    }, [ready, employee, navigate]);

    const submit = async () => {
        if (!empId.trim() || !password) {
            setError("Enter your employee ID and password.");
            return;
        }
        setBusy(true);
        setError("");
        setHint("");
        try {
            await apiJson("/api/auth/login", {
                method: "POST",
                body: JSON.stringify({ emp_id: empId.trim(), password, remember }),
            });
            await refetch();
            navigate("/attendance", { replace: true });
        } catch (err) {
            // The server returns one message for every failure reason on
            // purpose - do not try to be more specific here.
            setError(err.message || "Invalid credentials");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="dzs-root">
            {/* ── left: the banner ── */}
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

                {/* Static indicator. Three bars, the first one active. */}
                <div className="dzs-indicator" aria-hidden="true">
                    <span className="dzs-bar is-active" />
                    <span className="dzs-bar" />
                    <span className="dzs-bar" />
                </div>
            </section>

            {/* ── right: the form ── */}
            <section className="dzs-form">
                <Lockup sm />

                <h2 className="dzs-title">Sign in</h2>
                <p className="dzs-sub">
                    Your Dolluz employee ID and password — the same credentials as Inside D.
                </p>

                <div className="dzs-field">
                    <label className="dzs-label" htmlFor="empId">Employee ID or work email</label>
                    <input
                        id="empId"
                        className="dzs-input"
                        value={empId}
                        autoComplete="username"
                        placeholder="DZIND000"
                        onChange={(e) => { setEmpId(normaliseIdentifier(e.target.value)); setError(""); }}
                        onKeyDown={(e) => e.key === "Enter" && submit()}
                    />
                </div>

                <div className="dzs-field">
                    <label className="dzs-label" htmlFor="pw">Password</label>
                    <div className="dzs-reveal-wrap">
                        <input
                            id="pw"
                            className="dzs-input"
                            type={showPassword ? "text" : "password"}
                            value={password}
                            autoComplete="current-password"
                            onChange={(e) => { setPassword(e.target.value); setError(""); }}
                            onKeyDown={(e) => e.key === "Enter" && submit()}
                        />
                        <button
                            type="button"
                            className="dzs-reveal"
                            tabIndex={-1}
                            aria-label={showPassword ? "Hide password" : "Show password"}
                            aria-pressed={showPassword}
                            onClick={() => setShowPassword((v) => !v)}
                        >
                            {showPassword ? <FaEyeSlash /> : <FaEye />}
                        </button>
                    </div>
                </div>

                <div className="dzs-options">
                    <label className="dzs-remember">
                        <input
                            type="checkbox"
                            checked={remember}
                            onChange={(e) => setRemember(e.target.checked)}
                        />
                        Remember for 14 days
                    </label>
                    <button
                        type="button"
                        className="dzs-link"
                        onClick={() => { setError(""); setHint("Reset your password from Inside D, or ask an admin to reset it for you."); }}
                    >
                        Forgot password
                    </button>
                </div>

                {error && <div className="dzs-alert" role="alert">{error}</div>}
                {hint && <div className="dzs-hint">{hint}</div>}

                <button type="button" className="dzs-submit" disabled={busy} onClick={submit}>
                    {busy ? "Signing in…" : "Sign in"}
                </button>

                <p className="dzs-foot">
                    Access is granted in dAdmin. If sign-in is refused, ask an admin to
                    enable dAttendance on your record.
                </p>
            </section>
        </div>
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
