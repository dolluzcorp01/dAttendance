// ============================================================================
//  dAttendance - the calendar engine.
//
//  ONE function decides what every date is for one employee: a working day, a
//  week-off, a declared holiday, or outside their employment. Both the dAdmin
//  pages and the dAttendance employee app import this file, and it is byte-for-
//  byte identical in both projects. If you change one, copy it to the other -
//  a divergence here means an employee's sheet and payroll disagree about what
//  a day is, which is the worst failure this system can have.
//
//  Precedence, highest first:
//    1. NON_EMPLOYED  - before joining_date (never their working day)
//    2. WORK (adhoc)  - an att_adhoc_day row forces the day to working, and
//                       deliberately overrides both week-off and holiday
//    3. WEEKOFF       - per the month's work pattern
//    4. HOLIDAY       - an applicable dtime.holidays row
//    5. WORK          - everything else
//
//  Note the ordering difference from dTime's attendanceSummary.js, which puts
//  weekend ABOVE holiday so a holiday on a Sunday isn't double-counted. Same
//  intent here: a day lands in exactly one bucket, so
//      days_in_month = non_employed + weekoff + holiday + working
//  always reconciles.
// ============================================================================

// ---------------------------------------------------------------------------
// Date helpers. Dates are plain 'YYYY-MM-DD' strings and every Date object is
// built in UTC. A local-time Date shifts the day across midnight in any zone
// behind UTC and silently moves days into the wrong month.
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");
const toYmd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const dayOfWeekYmd = (ymd) => {
    const [y, m, d] = String(ymd).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun .. 6 = Sat
};

const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dateRange = (startYmd, endYmd) => {
    const out = [];
    if (!startYmd || !endYmd || endYmd < startYmd) return out;
    const [y, m, d] = startYmd.split("-").map(Number);
    const cur = new Date(Date.UTC(y, m - 1, d));
    for (;;) {
        const ymd = toYmd(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate());
        if (ymd > endYmd) break;
        out.push(ymd);
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
};

// ---------------------------------------------------------------------------
// Work patterns. Three, and only three.
// ---------------------------------------------------------------------------
const PATTERNS = {
    MON_FRI:   { label: "Mon - Fri",           weekendDow: [0, 6] },
    MON_SAT:   { label: "Mon - Sat",           weekendDow: [0] },
    MON_ADHOC: { label: "Mon - Adhoc Support", weekendDow: [0, 6] },
};
const isValidPattern = (p) => Object.prototype.hasOwnProperty.call(PATTERNS, p);
const DEFAULT_PATTERN = "MON_FRI";

// ---------------------------------------------------------------------------
// Holiday scoping.
//
// Mirrors dTime's holidayScope.js exactly: holiday_for is lowercase, and
// holiday_value is a COMMA-SEPARATED list. Whole-item comparison, never
// includes() - otherwise department "8" would match "18".
// ---------------------------------------------------------------------------
const holidayAppliesToEmployee = (holiday, employee) => {
    const list = String(holiday.holiday_value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    const has = (value) => value != null && list.includes(String(value).trim());

    switch (String(holiday.holiday_for ?? "").toLowerCase()) {
        case "general":      return true;
        case "department":   return holiday.holiday_value === "All" || has(employee.emp_department);
        case "job_position": return has(employee.job_position);
        case "location":     return has(employee.emp_location);
        case "employee":     return has(employee.emp_id);
        default:             return false;
    }
};

/** date -> holiday_name, for the holidays that apply to this employee. */
const expandHolidays = (holidayRows, employee) => {
    const byDate = new Map();
    for (const h of holidayRows) {
        if (!holidayAppliesToEmployee(h, employee)) continue;
        const from = h.holiday_date;
        const to = h.holiday_end || h.holiday_date;
        for (const ymd of dateRange(from, to)) {
            if (!byDate.has(ymd)) byDate.set(ymd, h.holiday_name || "Holiday");
        }
    }
    return byDate;
};

// ---------------------------------------------------------------------------
// The month calendar.
// ---------------------------------------------------------------------------
/**
 * @param {object} p
 * @param {object} p.employee     { emp_id, joining_date, emp_department, job_position, emp_location, active, deleted_time }
 * @param {number} p.year
 * @param {number} p.month        1-12
 * @param {string} p.pattern      MON_FRI | MON_SAT | MON_ADHOC
 * @param {string[]} p.adhocDays  'YYYY-MM-DD' forced-working dates
 * @param {object[]} p.holidays   rows from dtime.holidays overlapping the month
 * @returns {{days: object[], totals: object}}
 */
function buildMonthCalendar({ employee, year, month, pattern, adhocDays = [], holidays = [] }) {
    const usePattern = isValidPattern(pattern) ? pattern : DEFAULT_PATTERN;
    const weekend = new Set(PATTERNS[usePattern].weekendDow);
    const adhoc = new Set(adhocDays);
    const holidayByDate = expandHolidays(holidays, employee);
    const joined = employee.joining_date || null;

    const dim = daysInMonth(year, month);
    const days = [];
    let non_employed = 0, weekoff = 0, holiday = 0, working = 0, adhoc_used = 0;

    for (const date of dateRange(toYmd(year, month, 1), toYmd(year, month, dim))) {
        const dow = dayOfWeekYmd(date);
        const base = { date, dow, dow_label: DOW_LABEL[dow] };

        if (joined && date < joined) {
            non_employed++;
            days.push({ ...base, day_type: "NON_EMPLOYED", label: "Before joining date" });
            continue;
        }

        // Adhoc wins over week-off and holiday. This is the whole point of the
        // pattern: "work this specific day even though it is off".
        if (usePattern === "MON_ADHOC" && adhoc.has(date)) {
            adhoc_used++;
            working++;
            const overrode = weekend.has(dow) ? "week-off"
                : holidayByDate.has(date) ? holidayByDate.get(date) : null;
            days.push({
                ...base, day_type: "WORK", adhoc: true,
                label: overrode ? `Adhoc working day (overrides ${overrode})` : "Adhoc working day",
            });
            continue;
        }

        if (weekend.has(dow)) {
            weekoff++;
            days.push({ ...base, day_type: "WEEKOFF", label: `${DOW_LABEL[dow]} week-off` });
            continue;
        }

        if (holidayByDate.has(date)) {
            holiday++;
            days.push({ ...base, day_type: "HOLIDAY", label: holidayByDate.get(date) });
            continue;
        }

        working++;
        days.push({ ...base, day_type: "WORK", label: "Working day" });
    }

    return {
        days,
        totals: {
            days_in_month: dim,
            non_employed_days: non_employed,
            weekoff_days: weekoff,
            holiday_days: holiday,
            working_days: working,
            adhoc_days: adhoc_used,
            // days_off is what the Excel called "Total Day Off": every day the
            // employee is not expected to work. The Excel got this wrong on
            // 31-day months (its COUNTIF stopped at day 30).
            days_off: weekoff + holiday,
        },
    };
}

/** Last WORKING day of the month for this employee. Submit unlocks on it. */
function lastWorkingDate(calendar) {
    for (let i = calendar.days.length - 1; i >= 0; i--) {
        if (calendar.days[i].day_type === "WORK") return calendar.days[i].date;
    }
    return calendar.days.length ? calendar.days[calendar.days.length - 1].date : null;
}

// ---------------------------------------------------------------------------
// The monthly summary. THIS is the number payroll would read.
//
// Worked days and Loss of Pay
// ---------------------------
// The Excel used:
//     IF(leave >= allowed, working - leave, working)
// which is a cliff, not a threshold: 1 leave day costs nothing, 2 leave days
// cost both. That is almost certainly not what was intended, so this engine
// uses the excess-only rule instead:
//
//     worked_days = working_days - leave_days
//     lop_days    = MAX(0, leave_days - allowed_leave)
//     payable_days = working_days - lop_days
//
// If the business genuinely wants the cliff, change ONLY this function - it is
// the single place the rule lives.
// ---------------------------------------------------------------------------
function summariseSheet({ calendar, marks = {}, allowedLeave = 2 }) {
    let present = 0, leave = 0, marked_off = 0, unmarked = 0;

    for (const day of calendar.days) {
        const mark = marks[day.date];
        if (day.day_type === "WORK") {
            if (mark === "P") present++;
            else if (mark === "L") leave++;
            else unmarked++;
        } else if (day.day_type !== "NON_EMPLOYED") {
            marked_off++;
        }
    }

    const t = calendar.totals;
    const lop_days = Math.max(0, leave - allowedLeave);

    return {
        ...t,
        present_days: present,
        leave_days: leave,
        allowed_leave: allowedLeave,
        unmarked_days: unmarked,
        worked_days: t.working_days - leave,
        lop_days,
        payable_days: t.working_days - lop_days,
        complete: unmarked === 0,
        // Same self-check dTime's rollup does. If this is ever false the
        // response is wrong and nobody should be paid from it.
        reconciles:
            t.non_employed_days + t.weekoff_days + t.holiday_days + t.working_days === t.days_in_month &&
            present + leave + unmarked === t.working_days &&
            marked_off === t.weekoff_days + t.holiday_days,
    };
}

// ---------------------------------------------------------------------------
// Edit window. Answers "may the employee change this date right now?"
//
// The rule from the spec:
//   - never before their joining date
//   - never for a month that has not started
//   - a past month stays open until it is submitted
//   - in the CURRENT month: up to and including today, and from
//     fill_forward_from_day (default 24) the whole month opens so they can
//     fill the remainder ahead of the last working day
// ---------------------------------------------------------------------------
function isDateEditable({ date, today, employee, year, month, sheetStatus, fillForwardFromDay = 24 }) {
    const LOCKED = ["submitted", "edit_requested", "approved"];
    if (LOCKED.includes(sheetStatus)) return false;
    if (employee.joining_date && date < employee.joining_date) return false;

    const [ty, tm, td] = today.split("-").map(Number);
    if (year > ty || (year === ty && month > tm)) return false;     // future month
    if (year < ty || (year === ty && month < tm)) return true;      // past month, still open

    if (td >= fillForwardFromDay) return true;                       // month-end fill-forward
    return date <= today;                                            // otherwise up to today
}

module.exports = {
    PATTERNS,
    DEFAULT_PATTERN,
    isValidPattern,
    holidayAppliesToEmployee,
    expandHolidays,
    buildMonthCalendar,
    lastWorkingDate,
    summariseSheet,
    isDateEditable,
    // date helpers, exported so routes don't reimplement them
    toYmd,
    daysInMonth,
    dayOfWeekYmd,
    dateRange,
    DOW_LABEL,
};
