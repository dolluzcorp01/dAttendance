// ============================================================================
//  Builds the .xlsx an employee downloads, laid out like the workbook it
//  replaces (DZIND147_Attendance Sheet.xlsx, sheet "January-26").
//
//  THE LAYOUT
//  ----------
//        A          B                C         D              E ... (one column per day) ... | 7 summary columns
//   1 |  Dolluz Corp (A1:B1)     |  (C1:C2) | Month      |  <month name>, merged            | Attendance (merged)
//   2 |  Attendance Sheet (A2:B2)|          | <month>    |  Mon Tue Wed ...                 | Summary (merged)
//   3 |  SR No    | Employee Name| Emp ID   | Designation|  1-Jan 2-Jan ...                 | Present | Leave Taken | ...
//   4 |  1        | <name>       | <emp id> | <job>      |  P  H  L  P ...                  | <the numbers>
//   5 |           | 1            | Daily Employee Strength|  1  0  0  1 ...                 |
//
//  The summary block starts immediately after the last day column, so it sits
//  at AJ..AP for a 31-day month, AI..AO for 30, AG..AM for February.
//
//  WHAT IS DELIBERATELY NOT COPIED
//  -------------------------------
//  The original's sheets disagree with each other - August's month header still
//  reads "January", March's did too, and February-26 carried 2025 dates. Its
//  summary cells are live formulas, several of which are wrong: "Total Day Off"
//  is COUNTIF(E4:AH4,"H"), which stops at day 30 and under-counts every 31-day
//  month, and "Worked Days" is IF(leave>=allowed, working-leave, working) - a
//  cliff where two leave days cost both rather than none.
//
//  So the numbers here are written as VALUES from attendanceCalendar.js rather
//  than as formulas. The sheet looks identical; it just cannot recompute itself
//  into a wrong answer, and it is a record of an approved month rather than a
//  working file.
// ============================================================================
const ExcelJS = require("exceljs");
const cal = require("./attendanceCalendar");

// Palette lifted from the original workbook's theme (dk2 = 44546A) and its
// conditional-formatting rules.
const C = {
    header: "FF44546A",   // theme3 - every header cell, and an H day
    headerText: "FFFFFFFF",
    dayIdle: "FFD6DCE5",  // theme3 at 80% tint - a working day with no mark
    nameCell: "FF767171",  // theme2 at -50% tint - the employee name cell
    present: "FF00B050",
    leave: "FFFF0000",
    titleFill: "FFFFFF00",  // A1 is yellow in the original
    titleText: "FF0563C1",
    accentText: "FFFFFF00",
};

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

const thick = { style: "thick" };
const allThick = { top: thick, left: thick, bottom: thick, right: thick };
const centre = { horizontal: "center", vertical: "middle" };

/** Every cell in this sheet is boxed in thick borders and centred. */
function paint(cell, { fill, color, size = 12, bold = true, wrap = false, numFmt }) {
    cell.font = { name: "Calibri", size, bold, color: { argb: color || C.headerText } };
    if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { ...centre, wrapText: wrap };
    cell.border = allThick;
    if (numFmt) cell.numFmt = numFmt;
}

/**
 * Merge, then style EVERY cell in the range - not just the anchor.
 *
 * Excel draws a merged region's outline from the borders of the cells on its
 * edges, so styling only the top-left leaves the right and bottom edges of the
 * box open. Filling the whole range also keeps the background solid if the
 * merge is ever undone.
 */
function mergeStyled(ws, r1, c1, r2, c2, style) {
    ws.mergeCells(r1, c1, r2, c2);
    for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) paint(ws.getCell(r, c), style);
    }
    return ws.getCell(r1, c1);
}

/**
 * @param {object} p
 * @param {object} p.employee   { emp_id, emp_name, job_name }
 * @param {number} p.year
 * @param {number} p.month      1-12
 * @param {object} p.calendar   from cal.buildMonthCalendar
 * @param {object} p.summary    from cal.summariseSheet
 * @param {object} p.marks      { 'YYYY-MM-DD': 'P'|'L'|'H' }
 * @returns {Promise<Buffer>}
 */
async function buildAttendanceWorkbook({ employee, year, month, calendar, summary, marks }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "dAttendance";
    wb.created = new Date();

    // "January-26" - the naming the original uses for most of its sheets.
    const ws = wb.addWorksheet(`${MONTHS[month - 1]}-${String(year).slice(2)}`, {
        views: [{ showGridLines: false }],
    });

    const days = calendar.days;
    const n = days.length;
    const FIRST_DAY_COL = 5;                    // E
    const lastDayCol = FIRST_DAY_COL + n - 1;   // AI for 31 days
    const sumCol = lastDayCol + 1;              // summary starts right after

    // ── column widths ──
    ws.getColumn(1).width = 13;      // A  SR No
    ws.getColumn(2).width = 49.57;   // B  Employee Name
    ws.getColumn(3).width = 16.57;   // C  Emp ID
    ws.getColumn(4).width = 26.86;   // D  Designation
    for (let c = FIRST_DAY_COL; c <= lastDayCol; c++) ws.getColumn(c).width = 8.43;
    [9, 11, 12.5, 11.5, 12, 10.5, 10.5].forEach((w, i) => { ws.getColumn(sumCol + i).width = w; });

    // ── row heights, straight from the original ──
    ws.getRow(1).height = 37.5;
    ws.getRow(2).height = 30;
    ws.getRow(3).height = 48.75;
    ws.getRow(4).height = 17.25;
    ws.getRow(5).height = 20.25;

    const cell = (r, c) => ws.getCell(r, c);

    // ── row 1 ──
    mergeStyled(ws, 1, 1, 1, 2,
        { fill: C.titleFill, color: C.titleText, size: 28, bold: false }).value = "Dolluz Corp";

    mergeStyled(ws, 1, 3, 2, 3, { fill: C.header, color: C.accentText, size: 18 }); // C1:C2 spacer

    cell(1, 4).value = "Month";
    paint(cell(1, 4), { fill: C.header, size: 18 });

    mergeStyled(ws, 1, FIRST_DAY_COL, 1, lastDayCol,
        { fill: C.header, size: 18 }).value = MONTHS[month - 1];

    mergeStyled(ws, 1, sumCol, 1, sumCol + 6, { fill: C.header, size: 18 }).value = "Attendance";

    // ── row 2 ──
    mergeStyled(ws, 2, 1, 2, 2, { fill: C.header, size: 22 }).value = "Attendance Sheet";

    cell(2, 4).value = MONTHS[month - 1];
    paint(cell(2, 4), { fill: C.header, size: 18 });

    days.forEach((d, i) => {
        const c = cell(2, FIRST_DAY_COL + i);
        c.value = d.dow_label;                       // Mon, Tue, ...
        paint(c, { fill: C.header });
    });

    mergeStyled(ws, 2, sumCol, 2, sumCol + 6, { fill: C.header, size: 18 }).value = "Summary";

    // ── row 3: headers ──
    ["SR No", "Employee Name", "Emp ID", "Designation"].forEach((t, i) => {
        cell(3, i + 1).value = t;
        paint(cell(3, i + 1), { fill: C.header });
    });

    days.forEach((d, i) => {
        const c = cell(3, FIRST_DAY_COL + i);
        // A real date, so the column reads "1-Jan" and sorts/filters properly.
        const [y, m, dd] = d.date.split("-").map(Number);
        c.value = new Date(Date.UTC(y, m - 1, dd));
        paint(c, { fill: C.header, numFmt: "d-mmm" });
    });

    const SUMMARY_HEADERS = ["Present", "Leave Taken", "Allowed Leave", "Total Days in Month",
                             "Total Working Days", "Worked Days", "Total Day Off"];
    SUMMARY_HEADERS.forEach((t, i) => {
        cell(3, sumCol + i).value = t;
        paint(cell(3, sumCol + i), { fill: C.header, wrap: true });
    });

    // ── row 4: the employee ──
    cell(4, 1).value = 1;
    paint(cell(4, 1), { fill: C.header });
    // Name, id and designation share the grey band in the original.
    cell(4, 2).value = employee.emp_name;
    paint(cell(4, 2), { fill: C.nameCell });
    cell(4, 3).value = employee.emp_id;
    paint(cell(4, 3), { fill: C.nameCell });
    cell(4, 4).value = employee.job_name || "";
    paint(cell(4, 4), { fill: C.nameCell, size: 11 });

    days.forEach((d, i) => {
        const c = cell(4, FIRST_DAY_COL + i);
        // The server owns H. A non-working day is H whatever the sheet holds,
        // and a working day shows only what the employee marked.
        const v = d.day_type === "WORK" ? (marks[d.date] === "P" || marks[d.date] === "L" ? marks[d.date] : "")
                : d.day_type === "NON_EMPLOYED" ? ""
                : "H";
        c.value = v;
        // The original coloured these with conditional formatting. Direct fills
        // render identically and cannot recolour if someone edits the record.
        const fill = v === "P" ? C.present : v === "L" ? C.leave : v === "H" ? C.header : C.dayIdle;
        paint(c, { fill, color: v ? C.headerText : C.header });
    });

    const s = summary;
    [s.present_days, s.leave_days, s.allowed_leave, s.days_in_month,
     s.working_days, s.worked_days, s.days_off].forEach((v, i) => {
        cell(4, sumCol + i).value = v;
        paint(cell(4, sumCol + i), { fill: C.header });
    });

    // ── row 5: daily strength. One employee per sheet, so it is 1 or 0. ──
    paint(cell(5, 1), { fill: C.header });
    cell(5, 2).value = 1;
    paint(cell(5, 2), { fill: C.header });
    mergeStyled(ws, 5, 3, 5, 4, { fill: C.header, size: 14 }).value = "Daily Employee Strength";

    days.forEach((d, i) => {
        const c = cell(5, FIRST_DAY_COL + i);
        c.value = marks[d.date] === "P" && d.day_type === "WORK" ? 1 : 0;
        paint(c, { fill: C.header, size: 14 });
    });

    // Keep the name and id on screen while scrolling a 31-column month.
    ws.views = [{ state: "frozen", xSplit: 4, ySplit: 3, showGridLines: false }];

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
}

/** DZIND147_Attendance_Sheet_2026_09.xlsx */
const workbookFilename = (emp_id, year, month) =>
    `${emp_id}_Attendance_Sheet_${year}_${String(month).padStart(2, "0")}.xlsx`;

module.exports = { buildAttendanceWorkbook, workbookFilename, MONTHS };
