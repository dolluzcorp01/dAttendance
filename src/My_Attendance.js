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
    const loadMonth = useCallback(async (y, m) => {
        if (!y || !m) return;
        setLoading(true);
        setError("");
        try {
            const res = await apiJson(`/api/sheet/month?year=${y}&month=${m}`);
            setData(res);
            // Seed local marks from what's stored, so an unsaved edit is the
            // only difference between this and the server.
            const seed = {};
            for (const d of res.days) if (d.day_type === "WORK" && d.mark) seed[d.date] = d.mark;
            setMarks(seed);
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

    const chooseMark = (date, value) => {
        setMarks((m) => ({ ...m, [date]: value }));
        setPicker(null);
    };

    // Close on anything that would move the cell out from under the menu.
    // The grid scrolls horizontally, so a scroll must dismiss rather than
    // leave the menu pointing at the wrong day.
    useEffect(() => {
        if (!picker) return;
        const close = () => setPicker(null);
        const onKey = (e) => { if (e.key === "Escape") close(); };
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("scroll", close, true);
            window.removeEventListener("resize", close);
            window.removeEventListener("keydown", onKey);
        };
    }, [picker]);

    // A month change or a reload can drop the day the menu was anchored to.
    useEffect(() => { setPicker(null); }, [year, month]);

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
            await loadMonth(year, month);
        } catch (err) {
            flash(err.message);
        } finally { setBusy(false); }
    };

    const submit = async () => {
        setBusy(true);
        try {
            const res = await apiJson("/api/sheet/submit", {
                method: "POST",
                body: JSON.stringify({ year, month, marks }),
            });
            flash(res.approver_id ? `Submitted to ${res.approver_id}` : "Submitted for approval");
            await loadMonth(year, month);
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
            await loadMonth(year, month);
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
                                        onClick={submit}
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
                                            return (
                                                <td key={d.date} className="dz-grid-cell dz-grid-mark-cell">
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
                        <div className="dz-stats">
                            <Stat label="Present"            value={summary.present_days} tone="green" />
                            <Stat label="Leave taken"        value={summary.leave_days}
                                  tone={summary.leave_days > summary.allowed_leave ? "red" : "plain"} />
                            <Stat label="Allowed leave"      value={summary.allowed_leave} />
                            <Stat label="Days in month"      value={summary.days_in_month} />
                            <Stat label="Total working days" value={summary.working_days} />
                            <Stat label="Worked days"        value={summary.worked_days} />
                            <Stat label="Total day off"      value={summary.days_off} />
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
            </div>

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

            {toast && <div className="dz-toast">{toast}</div>}
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
