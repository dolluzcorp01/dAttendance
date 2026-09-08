// ============================================================================
//  dAttendance  ›  My attendance      (employee app, spec page 2)
//
//  Laid out like the Excel it replaces: one horizontal row of dates, one row
//  of marks, with the summary block underneath.
//
//  Every rule shown here (which day is editable, whether Submit is open,
//  whether Download is allowed) is decided by the SERVER and echoed in the
//  /month response. This component renders those flags - it does not compute
//  them a second time. Two implementations of the same rule is how they drift.
// ============================================================================
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { apiJson, apiFetch } from "./utils/api";
import { useSession } from "./utils/SessionContext";
import dolluzEagle from "./assets/img/app_eagle.png";
import TopNavbar from "./TopNavbar";
import "./My_Attendance.css";

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

const STATUS_PILL = {
    not_started:    ["grey",  "Not started"],
    draft:          ["amber", "Draft"],
    saved:          ["amber", "Saved"],
    submitted:      ["green", "Submitted"],
    edit_requested: ["orange", "Edit requested"],
    edit_open:      ["orange", "Edit open"],
    approved:       ["green", "Approved"],
    rejected:       ["red",   "Rejected"],
    completed:      ["green", "Completed"],
};

// The only two values an employee may set. H is written by the server for
// every week-off and holiday and is never accepted from the client, so it is
// deliberately absent from the picker.
const MARK_OPTIONS = [
    { value: "P", label: "Present", hint: "A normal working day", cls: "is-p" },
    { value: "L", label: "Leave",   hint: "Counts towards your allowed leave", cls: "is-l" },
];
// How much of the off-day was worked. Both are recorded as a full P once
// approved - att_sheet_day.day_status has no half-day value and payroll counts
// present days as whole numbers - so "half" is a note to the approver about
// what happened, not a 0.5 in the totals.
const PORTIONS = [
    { value: "full", label: "Full day", hint: "A normal working day's hours" },
    { value: "half", label: "Half day", hint: "A few hours, or half a shift" },
];

// The corner marker on a day cell, by claim status. No entry means no claim
// yet, and the cell offers a "+".
const SUPPORT_GLYPH = { pending: "•", approved: "\u2713", rejected: "!" };
const SUPPORT_LABEL = {
    pending: "Weekend support claim — waiting for your approver",
    approved: "Weekend support approved — counted as a working day",
    rejected: "Weekend support claim was rejected",
};

const MARK_LABEL = { P: "Present", L: "Leave", H: "Holiday or week-off" };

const prettyDate = (ymd) => {
    if (!ymd) return "";
    const [y, m, d] = ymd.split("-").map(Number);
    return `${String(d).padStart(2, "0")} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
};

export default function MyAttendance() {
    const { employee, setEmployee } = useSession();

    const [years, setYears] = useState([]);
    const [year, setYear] = useState(null);
    const [month, setMonth] = useState(new Date().getMonth() + 1);

    const [data, setData] = useState(null);      // the /month payload
    const [marks, setMarks] = useState({});      // local edits, keyed by date
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState(null);
    const [editModal, setEditModal] = useState(null);   // reason text, or null
    const [confirmSubmit, setConfirmSubmit] = useState(false);
    // The open support bubble: { day, top, bottom, left }. Same portal
    // trick as the P/L picker - see MarkPicker.
    const [supportAt, setSupportAt] = useState(null);
    // The claim being written: { day, portion, reason, step }.
    const [supportForm, setSupportForm] = useState(null);
    const [error, setError] = useState("");

    // The open P/L picker: { date, top, left, width }. Screen coordinates,
    // because the picker renders in a portal - see MarkPicker below.
    const [picker, setPicker] = useState(null);

    const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2600); };

    // ── load the year list once ────────────────────────────────────────────
    useEffect(() => {
        (async () => {
            try {
                const res = await apiJson("/api/sheet/years");
                setYears(res.years);
                setYear((y) => y ?? res.years[0]);
            } catch (err) {
                setError(err.message);
            }
        })();
    }, []);

    // ── load a month ───────────────────────────────────────────────────────
    // silent    - refresh the numbers underneath the sheet instead of tearing
    //             it down behind the loading placeholder. The placeholder is
    //             right for a first load or a month switch, where there is
    //             nothing correct to show yet; after a save or a request it
    //             unmounts the whole card and reads as a page reload.
    // keepEdits - carry unsaved grid clicks across a refresh that was not
    //             about them. Raising a support claim must not silently throw
    //             away marks the employee has made but not yet saved.
    const loadMonth = useCallback(async (y, m, { silent = false, keepEdits = false } = {}) => {
        if (!y || !m) return;
        if (!silent) setLoading(true);
        setError("");
        try {
            const res = await apiJson(`/api/sheet/month?year=${y}&month=${m}`);
            setData(res);
            // Seed local marks from what's stored, so an unsaved edit is the
            // only difference between this and the server.
            const seed = {};
            for (const d of res.days) if (d.day_type === "WORK" && d.mark) seed[d.date] = d.mark;
            setMarks((prev) => {
                if (!keepEdits) return seed;
                // Local marks are always a superset of the server's - chooseMark
                // only ever sets a value, it never clears one - so laying them
                // over the seed cannot resurrect a mark the employee removed.
                // A date the server no longer calls an editable working day is
                // dropped: the server is the authority on that.
                const byDate = new Map(res.days.map((d) => [d.date, d]));
                const next = { ...seed };
                for (const [date, mark] of Object.entries(prev)) {
                    const day = byDate.get(date);
                    if (day && day.day_type === "WORK" && day.editable) next[date] = mark;
                }
                return next;
            });
        } catch (err) {
            setData(null);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadMonth(year, month); }, [year, month, loadMonth]);

    // ── derived ────────────────────────────────────────────────────────────
    const summary = useMemo(() => {
        if (!data) return null;
        // Recompute present/leave/unmarked locally so the block reacts to
        // unsaved clicks. Everything else comes straight from the server.
        let present = 0, leave = 0, unmarked = 0;
        for (const d of data.days) {
            if (d.day_type !== "WORK") continue;
            const m = marks[d.date];
            if (m === "P") present++;
            else if (m === "L") leave++;
            else unmarked++;
        }
        const allowed = data.summary.allowed_leave;
        const working = data.summary.working_days;
        // Loss of pay is no longer shown on this page, but it still has to be
        // recomputed: payable_days depends on it, and dropping it from the
        // override would let the server's pre-edit values fall through from the
        // spread above and go stale against unsaved clicks. The number payroll
        // reads is the server's own, from summariseSheet().
        const lop = Math.max(0, leave - allowed);
        return {
            ...data.summary,
            present_days: present,
            leave_days: leave,
            unmarked_days: unmarked,
            worked_days: working - leave,
            lop_days: lop,
            payable_days: working - lop,
            complete: unmarked === 0,
        };
    }, [data, marks]);

    // A past month with nothing outstanding reads "Completed", not "Not started".
    const shownStatus = useMemo(() => {
        if (!data) return "not_started";
        const s = data.sheet.status;
        if (s !== "not_started" && s !== "draft") return s;
        if (data.flags.is_past_month) return "completed";
        return s;
    }, [data]);

    // Can the employee still change this month at all? The server is the
    // authority - writeMarks() refuses these states before it writes anything -
    // and this mirrors it so the page does not render controls that would be
    // rejected. Anything false here means the action row is read-only.
    const monthIsOpen = useMemo(() => {
        if (!data) return false;
        const f = data.flags;
        if (f.before_joining || f.is_future_month) return false;
        return !["submitted", "edit_requested", "approved"].includes(data.sheet.status);
    }, [data]);

    const dirty = useMemo(() => {
        if (!data) return false;
        const saved = {};
        for (const d of data.days) if (d.day_type === "WORK" && d.mark) saved[d.date] = d.mark;
        const a = Object.keys(saved), b = Object.keys(marks);
        if (a.length !== b.length) return true;
        return b.some((k) => saved[k] !== marks[k]);
    }, [data, marks]);

    // ── actions ────────────────────────────────────────────────────────────

    // Clicking a working day opens a small P / L menu rather than flipping the
    // value straight away. A blind toggle made every mis-click a silent edit to
    // a payroll input, and gave no way to say "leave" without passing through
    // "present" first.
    const openPicker = (day, event) => {
        if (!day.editable) return;
        if (picker?.date === day.date) { setPicker(null); return; }
        const r = event.currentTarget.getBoundingClientRect();
        setPicker({ date: day.date, top: r.top, bottom: r.bottom, left: r.left });
    };

    // ── weekend / holiday support ──────────────────────────────────────────
    const openSupport = (day, event) => {
        event.stopPropagation();
        if (supportAt?.day.date === day.date) { setSupportAt(null); return; }
        const r = event.currentTarget.getBoundingClientRect();
        setPicker(null);
        setSupportAt({ day, top: r.top, bottom: r.bottom, left: r.left });
    };

    const startSupportClaim = (day) => {
        setSupportAt(null);
        // A claim on a day that has not happened yet is a statement of intent,
        // not a record. Same request either way - only the wording changes.
        setSupportForm({
            day, portion: "full", reason: "", step: "form",
            future: day.date > data.today,
        });
    };

    const sendSupportClaim = async () => {
        if (!supportForm) return;
        const { day, portion, reason } = supportForm;
        setBusy(true);
        try {
            await apiJson("/api/sheet/support-request", {
                method: "POST",
                body: JSON.stringify({ year, month, date: day.date, portion, reason: reason.trim() }),
            });
            setSupportForm(null);
            flash("Sent to your approver");
            await loadMonth(year, month, { silent: true, keepEdits: true });
        } catch (err) {
            flash(err.message);
        } finally { setBusy(false); }
    };

    const withdrawSupportClaim = async (requestId) => {
        setBusy(true);
        try {
            await apiJson("/api/sheet/support-request/cancel", {
                method: "POST",
                body: JSON.stringify({ request_id: requestId }),
            });
            setSupportAt(null);
            flash("Claim withdrawn");
            await loadMonth(year, month, { silent: true, keepEdits: true });
        } catch (err) {
            flash(err.message);
        } finally { setBusy(false); }
    };

    const chooseMark = (date, value) => {
        setMarks((m) => ({ ...m, [date]: value }));
        setPicker(null);
    };

    // Close on anything that would move the cell out from under the menu.
    // The grid scrolls horizontally, so a scroll must dismiss rather than
    // leave the menu pointing at the wrong day.
    useEffect(() => {
        if (!picker && !supportAt) return;
        const close = () => { setPicker(null); setSupportAt(null); };
        const onKey = (e) => { if (e.key === "Escape") close(); };
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("scroll", close, true);
            window.removeEventListener("resize", close);
            window.removeEventListener("keydown", onKey);
        };
    }, [picker, supportAt]);

    // A month change or a reload can drop the day the menu was anchored to.
    useEffect(() => {
        setPicker(null);
        setConfirmSubmit(false);
        setSupportAt(null);
        setSupportForm(null);
    }, [year, month]);

    const markRemainingPresent = () => {
        setMarks((m) => {
            const next = { ...m };
            for (const d of data.days) {
                if (d.day_type === "WORK" && d.editable && !next[d.date]) next[d.date] = "P";
            }
            return next;
        });
    };

    const save = async () => {
        setBusy(true);
        try {
            await apiJson("/api/sheet/save", {
                method: "POST",
                body: JSON.stringify({ year, month, marks }),
            });
            flash("Sheet saved");
            await loadMonth(year, month, { silent: true });
        } catch (err) {
            flash(err.message);
        } finally { setBusy(false); }
    };

    const submit = async () => {
        setConfirmSubmit(false);
        setBusy(true);
        try {
            const res = await apiJson("/api/sheet/submit", {
                method: "POST",
                body: JSON.stringify({ year, month, marks }),
            });
            flash(res.approver_id ? `Submitted to ${res.approver_id}` : "Submitted for approval");
            await loadMonth(year, month, { silent: true });
        } catch (err) {
            flash(err.message);
        } finally { setBusy(false); }
    };

    const sendEditRequest = async () => {
        if (!editModal || !editModal.trim()) return;
        setBusy(true);
        try {
            await apiJson("/api/sheet/edit-request", {
                method: "POST",
                body: JSON.stringify({ year, month, reason: editModal.trim() }),
            });
            flash("Edit request sent");
            setEditModal(null);
            await loadMonth(year, month, { silent: true });
        } catch (err) {
            flash(err.message);
        } finally { setBusy(false); }
    };

    // Download goes through fetch rather than a plain link so the auth cookie
    // and the error body are both handled properly.
    const download = async () => {
        try {
            const res = await apiFetch(`/api/sheet/download?year=${year}&month=${month}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                flash(body.error || "Download failed");
                return;
            }
            // Take the name from Content-Disposition so the browser and the
            // server never disagree about the extension - they did once, when
            // this said .csv and the server had started sending .xlsx.
            const disp = res.headers.get("Content-Disposition") || "";
            const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
            const fallback = `${employee.emp_id}_Attendance_Sheet_${year}_${String(month).padStart(2, "0")}.xlsx`;

            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = match ? decodeURIComponent(match[1]) : fallback;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            flash("Sheet downloaded");
        } catch {
            flash("Download failed");
        }
    };

    // ── render ─────────────────────────────────────────────────────────────
    const [pillTone, pillLabel] = STATUS_PILL[shownStatus] || ["grey", shownStatus];
    const f = data?.flags;

    return (
        <div className="dz-att-shell">
            <header className="dz-topbar">
                <div className="dz-brand">
                    <img className="dz-brand-mark" src={dolluzEagle} alt="Dolluz Corp" />
                    <span className="dz-brand-name">dAttendance</span>
                </div>
                <div className="dz-topbar-right">
                    {/* The SERVER's date, not the browser's. Every lock on this
                        page - which days are editable, whether Submit is open -
                        is decided against this, so showing the machine's own
                        clock here would explain the wrong thing when the two
                        disagree. Read-only for the same reason: the server
                        ignores any date the client sends. */}
                    {data?.today && (
                        <div className="dz-today" title="The server's date. All date rules are applied against this.">
                            <span className="dz-today-label">Today</span>
                            <span className="dz-today-value">{prettyDate(data.today)}</span>
                        </div>
                    )}
                    {data?.leave_source === "dtime" && <span className="dz-pill dz-pill-navy">Leave from dTime</span>}
                    {/* Name, role and Sign out all live in here now - the chip
                        opens a dropdown carrying Logout, and clicking its
                        avatar opens the photo upload. Same component shape as
                        dSlip's TopNavbar. */}
                    <TopNavbar loggedInEmp={employee} setLoggedInEmp={setEmployee} />
                </div>
            </header>

            <div className="dz-page">
                <div className="dz-page-head">
                    <div>
                        <h1>My attendance</h1>
                        <p>
                            {employee?.joining_date
                                ? `You joined on ${prettyDate(employee.joining_date)}. Months before that are visible but locked.`
                                : "Mark each working day as Present or Leave, then submit at the end of the month."}
                        </p>
                    </div>
                    <div className="dz-year-picker">
                        <span>Year</span>
                        <select
                            className="dz-select"
                            value={year ?? ""}
                            onChange={(e) => setYear(Number(e.target.value))}
                        >
                            {years.map((y) => <option key={y} value={y}>{y}</option>)}
                        </select>
                    </div>
                </div>

                <div className="dz-month-strip">
                    {MONTHS.map((name, i) => (
                        <button
                            key={name}
                            type="button"
                            className={`dz-month-btn${month === i + 1 ? " is-active" : ""}`}
                            onClick={() => setMonth(i + 1)}
                        >
                            {name.slice(0, 3)}
                        </button>
                    ))}
                </div>

                {error && <div className="dz-notice dz-notice-red">{error}</div>}

                {loading && <div className="dz-card dz-loading">Loading {MONTHS[month - 1]}…</div>}

                {!loading && data && (
                    <div className="dz-card dz-sheet-card">
                        <div className="dz-sheet-head">
                            <div className="dz-sheet-head-left">
                                <span className="dz-sheet-title">{MONTHS[month - 1]} {year}</span>
                                <span className={`dz-pill dz-pill-${pillTone}`}>{pillLabel}</span>
                                <span className="dz-pill dz-pill-grey">{data.pattern_label}</span>
                            </div>
                            <div className="dz-sheet-actions">
                                {/* Marking and saving only exist while the month is
                                    open to the employee. On a closed month they were
                                    rendering greyed out, which offers something that
                                    can never happen - see monthIsOpen. */}
                                {monthIsOpen && (
                                    <button
                                        type="button"
                                        className="dz-btn dz-btn-sm dz-btn-quiet"
                                        disabled={busy || !data.days.some((d) => d.editable && !marks[d.date])}
                                        onClick={markRemainingPresent}
                                    >
                                        Mark remaining as present
                                    </button>
                                )}

                                {/* Download stays visible while disabled on purpose: the
                                    tooltip tells the employee it unlocks on submit, which
                                    is guidance rather than a dead end. */}
                                <button
                                    type="button"
                                    className="dz-btn dz-btn-sm dz-btn-ghost"
                                    disabled={!f.can_download}
                                    title={f.can_download ? "Download this sheet" : "Submit the sheet before downloading"}
                                    onClick={download}
                                >
                                    Download
                                </button>

                                {monthIsOpen && (
                                    <button
                                        type="button"
                                        className="dz-btn dz-btn-sm dz-btn-ghost"
                                        disabled={busy || !dirty}
                                        onClick={save}
                                    >
                                        Save
                                    </button>
                                )}

                                {/* Approved is final for the employee. No Request edit,
                                    and no disabled Submit either - a month that is
                                    finished should not offer a dead control. Only
                                    Download stays live. */}
                                {data.sheet.status === "submitted" ? (
                                    <button
                                        type="button"
                                        className="dz-btn dz-btn-sm dz-btn-dark"
                                        disabled={busy || data.sheet.edit_requests_left <= 0}
                                        title={data.sheet.edit_requests_left <= 0
                                            ? "You have used every edit request for this month" : ""}
                                        onClick={() => setEditModal("")}
                                    >
                                        Request edit ({data.sheet.edit_requests_left} left)
                                    </button>
                                ) : monthIsOpen ? (
                                    // Submit stays visible while disabled: its tooltip
                                    // says what is still missing, so it is instruction,
                                    // not a dead end.
                                    <button
                                        type="button"
                                        className="dz-btn dz-btn-sm dz-btn-primary"
                                        disabled={busy || !f.can_submit}
                                        title={
                                            !f.submit_window_open
                                                ? `Submit opens on ${prettyDate(f.last_working_date)}`
                                                : !summary.complete
                                                    ? "Mark every working day first" : ""
                                        }
                                        onClick={() => setConfirmSubmit(true)}
                                    >
                                        Submit
                                    </button>
                                ) : null}
                            </div>
                        </div>

                        <Notices data={data} summary={summary} />

                        {/* ── the Excel-shaped grid ── */}
                        <div className="dz-grid-wrap">
                            <table className="dz-grid">
                                <tbody>
                                    <tr>
                                        <td className="dz-grid-sticky dz-grid-head-cell">Day</td>
                                        {data.days.map((d) => (
                                            <td key={d.date}
                                                className={`dz-grid-cell dz-grid-head-cell${d.dow === 0 || d.dow === 6 ? " is-weekend" : ""}`}>
                                                {d.dow_label}
                                            </td>
                                        ))}
                                    </tr>
                                    <tr>
                                        <td className="dz-grid-sticky dz-grid-head-cell">Date</td>
                                        {data.days.map((d) => (
                                            <td key={d.date} className="dz-grid-cell dz-grid-date">{d.date.slice(8)}</td>
                                        ))}
                                    </tr>
                                    <tr>
                                        <td className="dz-grid-sticky dz-grid-name">
                                            {employee?.emp_name}
                                            <span>{employee?.emp_id}</span>
                                        </td>
                                        {data.days.map((d) => {
                                            const value = d.day_type === "WORK" ? (marks[d.date] || "") : "H";
                                            const cls = value === "P" ? "is-p" : value === "L" ? "is-l" : value === "H" ? "is-h" : "";
                                            // The corner marker shows on an off-day that can still
                                            // be claimed, AND on any day carrying a claim. Those are
                                            // different cells: once a claim is approved the day is a
                                            // working day, so its marker sits on a P, not on an H.
                                            const sup = d.support;
                                            const showDot = d.can_request_support || !!sup;
                                            return (
                                                <td key={d.date} className={`dz-grid-cell dz-grid-mark-cell ${cls}`}>
                                                    <button
                                                        type="button"
                                                        className={`dz-mark ${cls}${d.editable ? "" : " is-locked"}${picker?.date === d.date ? " is-open" : ""}`}
                                                        disabled={!d.editable}
                                                        aria-haspopup={d.editable ? "listbox" : undefined}
                                                        aria-expanded={d.editable ? picker?.date === d.date : undefined}
                                                        aria-label={`${prettyDate(d.date)} — ${MARK_LABEL[value] || "not marked"}`}
                                                        title={`${prettyDate(d.date)} — ${d.label}${d.approved_leave ? " · approved leave in dTime" : ""}`}
                                                        onClick={(e) => openPicker(d, e)}
                                                    >
                                                        {value || "-"}
                                                    </button>
                                                    {showDot && (
                                                        <button
                                                            type="button"
                                                            className={`dz-support-dot${sup ? ` is-${sup.status}` : ""}${supportAt?.day.date === d.date ? " is-open" : ""}`}
                                                            aria-haspopup="dialog"
                                                            aria-expanded={supportAt?.day.date === d.date}
                                                            aria-label={`${prettyDate(d.date)} — ${SUPPORT_LABEL[sup?.status] || "record weekend support"}`}
                                                            title={SUPPORT_LABEL[sup?.status] || "Worked this day? Record it"}
                                                            onClick={(e) => openSupport(d, e)}
                                                        >
                                                            {SUPPORT_GLYPH[sup?.status] || "i"}
                                                        </button>
                                                    )}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                    <tr>
                                        <td className="dz-grid-sticky dz-grid-head-cell">Working day</td>
                                        {data.days.map((d) => (
                                            <td key={d.date} className="dz-grid-cell dz-grid-flag">
                                                {d.day_type === "WORK" ? (d.adhoc ? "A" : "1") : "0"}
                                            </td>
                                        ))}
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        {/* ── summary block, same fields as the Excel ── */}
                        {/* These seven labels, in this order, are the summary
                            headers of the .xlsx - see SUMMARY_HEADERS in
                            utils/attendanceWorkbook.js. Title Case with the
                            minor word ("in") left lowercase, exactly as the
                            original workbook writes them. Change one, change
                            both, or the download stops matching the screen. */}
                        <div className="dz-stats">
                            <Stat label="Present"             value={summary.present_days} tone="green" />
                            <Stat label="Leave Taken"         value={summary.leave_days}
                                  tone={summary.leave_days > summary.allowed_leave ? "red" : "plain"} />
                            <Stat label="Allowed Leave"       value={summary.allowed_leave} />
                            <Stat label="Total Days in Month" value={summary.days_in_month} />
                            <Stat label="Total Working Days"  value={summary.working_days} />
                            <Stat label="Worked Days"         value={summary.worked_days} />
                            <Stat label="Total Day Off"       value={summary.days_off} />
                        </div>

                        <div className="dz-legend">
                            <Legend cls="is-p" label="P — present" />
                            <Legend cls="is-l" label="L — leave" />
                            <Legend cls="is-h" label="H — holiday or week-off (set by admin)" />
                            {monthIsOpen && <span>Click a working day to choose Present or Leave.</span>}
                            {data.leave_source === "dtime" &&
                                <span>L days come from approved leave in dTime and can't be changed here.</span>}
                        </div>

                        {/* A nudge to fill the sheet, so it belongs only on a month
                            that can still be filled. On a submitted or approved one
                            it was telling the employee to do something they had
                            already done. */}
                        {monthIsOpen && (
                            <div className="dz-payroll-note">
                                <InfoIcon />
                                <span>
                                    Please fill and submit your attendance sheet without delay — your
                                    salary for {MONTHS[month - 1]} is processed from these numbers.
                                    A sheet that arrives after payroll has run is paid in the next cycle.
                                </span>
                            </div>
                        )}
                    </div>
                )}

                {picker && (
                    <MarkPicker
                        at={picker}
                        current={marks[picker.date] || ""}
                        onChoose={(v) => chooseMark(picker.date, v)}
                        onClose={() => setPicker(null)}
                    />
                )}

                {supportAt && (
                    <SupportBubble
                        at={supportAt}
                        today={data.today}
                        busy={busy}
                        onStart={() => startSupportClaim(supportAt.day)}
                        onWithdraw={withdrawSupportClaim}
                        onClose={() => setSupportAt(null)}
                    />
                )}
            </div>

            {/* Submitting is one-way: the sheet locks, and reopening it costs
                one of a small number of edit requests. That is worth a beat of
                confirmation - and it doubles as a last look at the counts. */}
            {confirmSubmit && data && (
                <div className="dz-modal-backdrop" onClick={() => setConfirmSubmit(false)}>
                    <div className="dz-modal dz-modal-sm" onClick={(e) => e.stopPropagation()}>
                        <div className="dz-modal-head">
                            <span className="dz-modal-title">
                                Submit {MONTHS[month - 1]} {year}?
                            </span>
                            <button type="button" className="dz-btn dz-btn-sm dz-btn-quiet"
                                    onClick={() => setConfirmSubmit(false)}>Close</button>
                        </div>
                        <div className="dz-modal-body">
                            <p className="dz-modal-note">
                                Once submitted the sheet goes to your reporting manager and
                                locks — you cannot change it afterwards without raising an
                                edit request, and you get {data.sheet.edit_requests_left} of
                                those for this month.
                            </p>
                            <div className="dz-confirm-figures">
                                <div><span>Present</span><strong>{summary.present_days}</strong></div>
                                <div><span>Leave</span><strong>{summary.leave_days}</strong></div>
                                <div><span>Total working days</span><strong>{summary.working_days}</strong></div>
                            </div>
                        </div>
                        <div className="dz-modal-foot">
                            <button type="button" className="dz-btn dz-btn-ghost"
                                    onClick={() => setConfirmSubmit(false)}>Cancel</button>
                            <button type="button" className="dz-btn dz-btn-primary"
                                    disabled={busy} onClick={submit}>
                                Yes, submit
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {editModal !== null && (
                <div className="dz-modal-backdrop" onClick={() => setEditModal(null)}>
                    <div className="dz-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="dz-modal-head">
                            <span className="dz-modal-title">Request an edit</span>
                            <button type="button" className="dz-btn dz-btn-sm dz-btn-quiet"
                                    onClick={() => setEditModal(null)}>Close</button>
                        </div>
                        <div className="dz-modal-body">
                            <p className="dz-modal-note">
                                Your {MONTHS[month - 1]} {year} sheet is submitted and locked. Tell the approver
                                what needs changing — you have {data?.sheet.edit_requests_left} request
                                {data?.sheet.edit_requests_left === 1 ? "" : "s"} left for this month.
                            </p>
                            <label className="dz-label" htmlFor="reason">Reason</label>
                            <textarea
                                id="reason"
                                className="dz-input dz-textarea"
                                rows={4}
                                value={editModal}
                                placeholder="e.g. 12th was marked leave but it was approved comp-off"
                                onChange={(e) => setEditModal(e.target.value)}
                            />
                        </div>
                        <div className="dz-modal-foot">
                            <button type="button" className="dz-btn dz-btn-ghost" onClick={() => setEditModal(null)}>Cancel</button>
                            <button type="button" className="dz-btn dz-btn-primary"
                                    disabled={busy || !editModal.trim()} onClick={sendEditRequest}>
                                Send request
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {supportForm && (
                <SupportModal
                    form={supportForm}
                    setForm={setSupportForm}
                    busy={busy}
                    onSend={sendSupportClaim}
                    onClose={() => setSupportForm(null)}
                />
            )}

            {toast && <div className="dz-toast">{toast}</div>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// The bubble behind the corner marker on an off-day.
//
// Portalled to <body> for the same reason MarkPicker is: the grid scrolls
// horizontally, so anything positioned inside a cell gets clipped by it.
// ---------------------------------------------------------------------------
function SupportBubble({ at, today, busy, onStart, onWithdraw, onClose }) {
    const ref = useRef(null);
    const { day } = at;
    const sup = day.support;
    const ahead = day.date > today;

    useEffect(() => {
        const onDown = (e) => {
            if (ref.current && ref.current.contains(e.target)) return;
            // The marker's own click handler toggles this bubble. If mousedown
            // closed it here, that click would immediately reopen it.
            if (e.target.closest && e.target.closest(".dz-support-dot")) return;
            onClose();
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [onClose]);

    const WIDTH = 246;
    const height = sup ? 168 : 132;
    const left = Math.max(8, Math.min(at.left - WIDTH + 26, window.innerWidth - WIDTH - 8));
    const flipUp = at.bottom + height + 8 > window.innerHeight;
    const top = flipUp ? Math.max(8, at.top - height - 4) : at.bottom + 4;

    return createPortal(
        <div ref={ref} className="dz-support-pop" role="dialog"
             aria-label="Weekend support" style={{ top, left, width: WIDTH }}>
            <div className="dz-support-pop-head">
                <span className="dz-support-pop-date">{prettyDate(day.date)}</span>
                <span className="dz-support-pop-label">{day.label}</span>
            </div>

            {sup ? (
                <div className="dz-support-pop-body">
                    <span className={`dz-support-chip is-${sup.status}`}>
                        {sup.status === "pending" ? "Waiting for approval"
                            : sup.status === "approved" ? "Approved"
                            : "Rejected"}
                        <em>{sup.day_portion === "half" ? "half day" : "full day"}</em>
                    </span>
                    <p className="dz-support-pop-reason">{sup.reason}</p>
                    {sup.decision_note && (
                        <p className="dz-support-pop-note">
                            <strong>Approver:</strong> {sup.decision_note}
                        </p>
                    )}
                    {sup.status === "pending" && (
                        <button type="button" className="dz-btn dz-btn-sm dz-btn-ghost dz-support-wide"
                                disabled={busy} onClick={() => onWithdraw(sup.request_id)}>
                            Withdraw claim
                        </button>
                    )}
                    {sup.status === "rejected" && day.can_request_support && (
                        <button type="button" className="dz-btn dz-btn-sm dz-btn-primary dz-support-wide"
                                disabled={busy} onClick={onStart}>
                            Raise it again
                        </button>
                    )}
                </div>
            ) : (
                <div className="dz-support-pop-body">
                    <p className="dz-support-pop-lead">
                        {ahead
                            ? "Working this day? Tell your approver now and it can be counted as a working day."
                            : "Worked on this day? Record it and your approver can count it as a working day."}
                    </p>
                    <button type="button" className="dz-btn dz-btn-sm dz-btn-primary dz-support-wide"
                            disabled={busy} onClick={onStart}>
                        Record Weekend Support
                    </button>
                </div>
            )}
        </div>,
        document.body
    );
}

// ---------------------------------------------------------------------------
// Two steps: write the claim, then confirm it. The confirm is not ceremony -
// it goes to a person, and a half-day typed as a full day is the kind of thing
// you only notice when it is read back to you.
// ---------------------------------------------------------------------------
function SupportModal({ form, setForm, busy, onSend, onClose }) {
    const { day, portion, reason, step, future } = form;
    const ready = reason.trim().length > 0;
    const set = (patch) => setForm((f) => ({ ...f, ...patch }));

    return (
        <div className="dz-modal-backdrop" onClick={onClose}>
            <div className="dz-modal dz-modal-sm" onClick={(e) => e.stopPropagation()}>
                <div className="dz-modal-head">
                    <span className="dz-modal-title">
                        {step === "form" ? "Record Weekend Support" : "Send this to your approver?"}
                    </span>
                    <button type="button" className="dz-btn dz-btn-sm dz-btn-quiet" onClick={onClose}>
                        Close
                    </button>
                </div>

                {step === "form" ? (
                    <>
                        <div className="dz-modal-body">
                            <p className="dz-modal-note">
                                <strong>{prettyDate(day.date)}</strong> is {day.label.toLowerCase()}.
                                Tell your approver what you {future ? "will be working on" : "worked on"}.
                                If they approve it, the day becomes a working day and is marked
                                <strong> P</strong>.
                            </p>

                            <div className="dz-portion-row" role="radiogroup" aria-label="How much of the day">
                                {PORTIONS.map((o) => (
                                    <button
                                        key={o.value}
                                        type="button"
                                        role="radio"
                                        aria-checked={portion === o.value}
                                        className={`dz-portion${portion === o.value ? " is-on" : ""}`}
                                        onClick={() => set({ portion: o.value })}
                                    >
                                        <span className="dz-portion-label">{o.label}</span>
                                        <span className="dz-portion-hint">{o.hint}</span>
                                    </button>
                                ))}
                            </div>

                            <label className="dz-label" htmlFor="support-reason">
                                {future ? "What will you be working on?" : "What did you work on?"}
                            </label>
                            <textarea
                                id="support-reason"
                                className="dz-input dz-textarea"
                                rows={3}
                                maxLength={500}
                                value={reason}
                                placeholder="e.g. production release support with the infra team"
                                onChange={(e) => set({ reason: e.target.value })}
                            />
                        </div>
                        <div className="dz-modal-foot">
                            <button type="button" className="dz-btn dz-btn-ghost" onClick={onClose}>Cancel</button>
                            <button type="button" className="dz-btn dz-btn-primary"
                                    disabled={!ready} onClick={() => set({ step: "confirm" })}>
                                Continue
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="dz-modal-body">
                            <p className="dz-modal-note">
                                Your approver decides this in dAdmin. Until they do, the day stays
                                marked H on your sheet.
                            </p>
                            <dl className="dz-support-review">
                                <div><dt>Day</dt><dd>{prettyDate(day.date)}</dd></div>
                                <div><dt>Normally</dt><dd>{day.label}</dd></div>
                                <div><dt>{future ? "Working" : "Worked"}</dt>
                                     <dd>{portion === "half" ? "Half day" : "Full day"}</dd></div>
                                <div><dt>Reason</dt><dd>{reason.trim()}</dd></div>
                            </dl>
                        </div>
                        <div className="dz-modal-foot">
                            <button type="button" className="dz-btn dz-btn-ghost"
                                    disabled={busy} onClick={() => set({ step: "form" })}>
                                Back
                            </button>
                            <button type="button" className="dz-btn dz-btn-primary"
                                    disabled={busy} onClick={onSend}>
                                Yes, send it
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
function Notices({ data, summary }) {
    const f = data.flags;
    const s = data.sheet.status;
    const out = [];

    if (f.before_joining) out.push(["grey", "You had not joined in this month, so it is read-only."]);
    else if (f.is_future_month) out.push(["grey", "This month hasn't started yet."]);
    else if (s === "edit_requested") out.push(["amber", "Your edit request is with the approver. The sheet stays locked until they respond."]);
    else if (s === "submitted") out.push(["green", "Submitted and waiting for approval. Raise an edit request if something is wrong."]);
    else if (s === "approved") out.push(["green",
        "Approved and closed. This month can no longer be changed — if something is wrong, ask an admin. You can still download the sheet."]);
    else if (s === "rejected") out.push(["red", "Your sheet was rejected. Correct it and submit again."]);
    else if (s === "edit_open") out.push(["amber", "Your edit request was accepted — the sheet is open again. Submit it once you're done."]);
    else if (f.is_current_month && !f.submit_window_open) {
        out.push(["info",
            `Submit opens on ${prettyDate(f.last_working_date)}, the last working day of this month. ` +
            `From the ${f.fill_forward_from_day}th you can fill the rest of the month ahead of time.`]);
    }

    if (summary && summary.unmarked_days > 0 && !f.is_future_month && !f.before_joining) {
        out.push(["amber",
            `${summary.unmarked_days} working day${summary.unmarked_days > 1 ? "s are" : " is"} still unmarked.`]);
    }

    // dTime says one thing, the sheet says another. Advisory - it does not block.
    if (data.leave_mismatch?.length) {
        out.push(["amber",
            `${data.leave_mismatch.length} day(s) disagree with your approved leave in dTime: ` +
            data.leave_mismatch.slice(0, 4).map((m) => `${m.date} marked ${m.marked}`).join(", ") +
            (data.leave_mismatch.length > 4 ? "…" : "")]);
    }

    if (!data.holidays.length) {
        out.push(["amber",
            "No holidays are configured in dTime for this month, so every weekday counts as a working day."]);
    }

    return out.map(([tone, text], i) => (
        <div key={i} className={`dz-notice dz-notice-${tone}`}>{text}</div>
    ));
}

// ---------------------------------------------------------------------------
//  The P / L picker.
//
//  Rendered through a portal at fixed screen coordinates rather than inside the
//  cell. The grid lives in an overflow-x container, and a menu positioned
//  inside it would be clipped at the row edge or force a vertical scrollbar.
// ---------------------------------------------------------------------------
function MarkPicker({ at, current, onChoose, onClose }) {
    const ref = useRef(null);

    useEffect(() => {
        const onDown = (e) => {
            if (ref.current && ref.current.contains(e.target)) return;
            // Leave the day cells alone. If this closed the menu on mousedown,
            // the click that follows would re-open it on the very cell the user
            // was trying to close - so let the cell's own click handler decide.
            if (e.target.closest && e.target.closest(".dz-mark")) return;
            onClose();
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [onClose]);

    useEffect(() => { ref.current?.querySelector(".dz-mark-option")?.focus(); }, []);

    // Keep the menu on screen when the cell sits near the right or bottom edge.
    const WIDTH = 172, HEIGHT = 104;
    const left = Math.max(8, Math.min(at.left, window.innerWidth - WIDTH - 8));
    const flipUp = at.bottom + HEIGHT + 8 > window.innerHeight;
    const top = flipUp ? Math.max(8, at.top - HEIGHT - 4) : at.bottom + 4;

    return createPortal(
        <div
            ref={ref}
            className="dz-mark-menu"
            role="listbox"
            aria-label="Mark this day as"
            style={{ top, left, width: WIDTH }}
        >
            {MARK_OPTIONS.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={current === o.value}
                    className={`dz-mark-option ${o.cls}${current === o.value ? " is-current" : ""}`}
                    onClick={() => onChoose(o.value)}
                >
                    <span className={`dz-mark-badge ${o.cls}`}>{o.value}</span>
                    <span className="dz-mark-text">
                        <span className="dz-mark-label">{o.label}</span>
                        <span className="dz-mark-hint">{o.hint}</span>
                    </span>
                    {current === o.value && <span className="dz-mark-tick" aria-hidden="true">✓</span>}
                </button>
            ))}
        </div>,
        document.body
    );
}

function InfoIcon() {
    return (
        <svg className="dz-info-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
            <path d="M8 7v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
    );
}

function Stat({ label, value, tone = "plain" }) {
    return (
        <div className="dz-stat">
            <div className="dz-stat-label">{label}</div>
            <div className={`dz-stat-value tone-${tone}`}>{value}</div>
        </div>
    );
}

function Legend({ cls, label }) {
    return (
        <span className="dz-legend-item">
            <span className={`dz-legend-swatch ${cls}`} />
            {label}
        </span>
    );
}
