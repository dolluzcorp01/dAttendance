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
//  A WORKING FILE, LIKE THE ORIGINAL
//  ---------------------------------
//  Every feature of the original's sheets is reproduced, so the download works
//  the way people used the spreadsheet: row 4 is a P / L / H dropdown, the day
//  colours follow the value through conditional formatting, and the month
//  header, the date chain, every summary cell and the daily-strength row are
//  live formulas. Each formula also carries its computed result, so the file
//  shows the right numbers before Excel recalculates anything - and those
//  results come from attendanceCalendar.js, so a download always agrees with
//  the page it was downloaded from.
//
//  Three formulas deliberately differ from the original, because the original's
//  would disagree with the page (and with the payroll behind it):
//    Total Day Off       COUNTIF over the WHOLE month. The original's stopped at
//                        E4:AH4 (day 30) and under-counted every 31-day month.
//    Total Working Days  Days in month - Total Day Off. The original counted
//                        Mon-Fri off the day names, so it ignored holidays,
//                        adhoc days and the Mon-Sat pattern entirely.
//    Worked Days         Working days - Leave taken. The original's
//                        IF(leave>=allowed, working-leave, working) is a cliff:
//                        two leave days cost both, one costs nothing.
//  The dropdown's list is written "P,L,H" rather than the original's "P, L, H",
//  so what lands in the cell is exactly the letter the formulas count.
// ============================================================================
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const cal = require("./attendanceCalendar");

// The logo sits on C1:C2 exactly as the original workbook anchors it. It is the
// white-panel build of DOLLUZ_Full_Logo.png: the raw asset has a black wordmark
// on transparency, which disappears against the navy cell - the original solves
// that with a white panel behind it, so this does the same.
// Regenerate with the snippet in src/assets/img/README.md.
const LOGO_PATH = path.join(__dirname, "..", "..", "assets", "img", "app_excel_logo.png");
let LOGO_BUFFER = null;
try {
    LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
} catch (err) {
    // A missing logo must not cost an employee their download.
    console.warn("[workbook] logo not found at", LOGO_PATH, "- sheets will render without it");
}

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

// The grid lines are WHITE, not the default black. On a navy sheet a black
// thick border reads as a heavy shadow around every cell; white is what makes
// the original look like a ruled table.
const thick = { style: "thick", color: { argb: C.headerText } };
const allThick = { top: thick, left: thick, bottom: thick, right: thick };
const centre = { horizontal: "center", vertical: "middle" };

/**
 * Every cell in this sheet is boxed in thick white borders, centred, and
 * underlined. The underline is on everything in the original except the
 * employee name, so it defaults on and B4 opts out.
 */
function paint(cell, { fill, color, size = 12, bold = true, wrap = false, numFmt, underline = true }) {
    cell.font = {
        name: "Calibri", size, bold, underline,
        color: { argb: color || C.headerText },
    };
    if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { ...centre, wrapText: wrap };
    cell.border = allThick;
    if (numFmt) cell.numFmt = numFmt;
}

/**
 * Merge a range and style it.
 *
 * Only the anchor carries the style, which is how Excel itself writes these -
 * the members of a merged range in the original workbook have no fill either.
 * Excel paints the whole region, and draws its outline, from the anchor.
 */
function mergeStyled(ws, r1, c1, r2, c2, style) {
    ws.mergeCells(r1, c1, r2, c2);
    const anchor = ws.getCell(r1, c1);
    paint(anchor, style);
    return anchor;
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
    const colLetter = (n) => ws.getColumn(n).letter;

    // ── row 1 ──
    // "Dolluz Corp" links out, as it does in the original. Its blue-and-
    // underlined styling is already hyperlink styling, so it reads as one.
    mergeStyled(ws, 1, 1, 1, 2, { fill: C.titleFill, color: C.titleText, size: 28, bold: false })
        .value = { text: "Dolluz Corp", hyperlink: "https://dolluzcorp.com/" };

    // C1:C2 stays navy and the logo sits on top of it, exactly as the original
    // does: the image carries its own white panel, so the navy shows around it.
    mergeStyled(ws, 1, 3, 2, 3, { fill: C.header, color: C.accentText, size: 18 });
    if (LOGO_BUFFER) {
        const imgId = wb.addImage({ buffer: LOGO_BUFFER, extension: "png" });
        // Span the whole C1:C2 block rather than placing a fixed-size square in
        // it. The original anchors it the same way - a twoCellAnchor from C1 to
        // C2 - so the logo grows with the cell instead of floating in a corner.
        ws.addImage(imgId, { tl: { col: 2, row: 0 }, br: { col: 3, row: 2 }, editAs: "oneCell" });
    }

    cell(1, 4).value = "Month";
    paint(cell(1, 4), { fill: C.header, size: 18 });

    // =D2, as the original's April and June sheets have it. The sheets that
    // typed the name instead are the ones whose header still said "January"
    // in August.
    mergeStyled(ws, 1, FIRST_DAY_COL, 1, lastDayCol,
        { fill: C.header, size: 18 }).value = { formula: "D2", result: MONTHS[month - 1] };

    mergeStyled(ws, 1, sumCol, 1, sumCol + 6, { fill: C.header, size: 18 }).value = "Attendance";

    // ── row 2 ──
    mergeStyled(ws, 2, 1, 2, 2, { fill: C.header, size: 22 }).value = "Attendance Sheet";

    // The month name under "Month" takes the same grey band as the employee
    // row, not the navy of the headers around it.
    cell(2, 4).value = MONTHS[month - 1];
    paint(cell(2, 4), { fill: C.nameCell, size: 18 });

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
        // The first day is the date itself; every later one is the original's
        // chain, =+E3+1, so the row can never skip or repeat a day.
        const [y, m, dd] = d.date.split("-").map(Number);
        const date = new Date(Date.UTC(y, m - 1, dd));
        c.value = i === 0 ? date : { formula: `+${colLetter(FIRST_DAY_COL + i - 1)}3+1`, result: date };
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
    // Name, id and designation share the grey band in the original. The name is
    // the single cell in the whole sheet that is NOT underlined.
    cell(4, 2).value = employee.emp_name;
    paint(cell(4, 2), { fill: C.nameCell, underline: false });
    cell(4, 3).value = employee.emp_id;
    paint(cell(4, 3), { fill: C.nameCell });
    cell(4, 4).value = employee.job_name || "";
    paint(cell(4, 4), { fill: C.nameCell, size: 11 });

    const dayVals = [];
    days.forEach((d, i) => {
        const c = cell(4, FIRST_DAY_COL + i);
        // The server owns H. A non-working day is H whatever the sheet holds,
        // and a working day shows only what the employee marked.
        const v = d.day_type === "WORK" ? (marks[d.date] === "P" || marks[d.date] === "L" ? marks[d.date] : "")
                : d.day_type === "NON_EMPLOYED" ? ""
                : "H";
        dayVals.push(v);
        c.value = v;
        // Painted directly AND by the conditional formatting below. The direct
        // fill is what a viewer without conditional formatting shows; the
        // conditional rules are what make a cell recolour when somebody picks a
        // different value from the dropdown.
        const fill = v === "P" ? C.present : v === "L" ? C.leave : v === "H" ? C.header : C.dayIdle;
        paint(c, { fill, color: v ? C.headerText : C.header });
        // The original's dropdown, on every day cell.
        c.dataValidation = {
            type: "list",
            allowBlank: true,
            formulae: ['"P,L,H"'],
            showErrorMessage: true,
            errorStyle: "stop",
            errorTitle: "Attendance",
            error: "Choose P (present), L (leave) or H (holiday / week-off).",
        };
    });

    // The original's colour rules - P green, L red, H navy, white text - plus
    // one it lacked: a cleared cell goes back to the idle colour instead of
    // keeping the fill it had before it was emptied.
    const dayRow = `${colLetter(FIRST_DAY_COL)}4:${colLetter(lastDayCol)}4`;
    const cfFill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb }, bgColor: { argb } });
    const whiteText = { color: { argb: C.headerText } };
    ws.addConditionalFormatting({
        ref: dayRow,
        rules: [
            { type: "cellIs", operator: "equal", formulae: ['"P"'], style: { fill: cfFill(C.present), font: whiteText } },
            { type: "cellIs", operator: "equal", formulae: ['"L"'], style: { fill: cfFill(C.leave), font: whiteText } },
            { type: "cellIs", operator: "equal", formulae: ['"H"'], style: { fill: cfFill(C.header), font: whiteText } },
            { type: "expression", formulae: [`LEN(${colLetter(FIRST_DAY_COL)}4)=0`], style: { fill: cfFill(C.dayIdle) } },
        ],
    });

    // Live formulas over row 4, in the original's columns, each carrying the
    // app's own number as its cached result. See the header for the three
    // that deliberately differ from the original.
    const s = summary;
    const sumL = (i) => colLetter(sumCol + i);   // Present, Leave, Allowed, Days, Working, Worked, Off
    const dayNames = `${colLetter(FIRST_DAY_COL)}2:${colLetter(lastDayCol)}2`;
    // Before the joining date a day is neither worked nor off, and is blank in
    // row 4 - so those days come off Working as a fixed count.
    const beforeJoining = s.non_employed_days ? `-${s.non_employed_days}` : "";
    [
        { formula: `COUNTIF(${dayRow},"P")`, result: s.present_days },
        { formula: `COUNTIF(${dayRow},"L")`, result: s.leave_days },
        s.allowed_leave,                                   // a policy value, typed in the original too
        { formula: `COUNTA(${dayNames})`, result: s.days_in_month },
        { formula: `${sumL(3)}4-${sumL(6)}4${beforeJoining}`, result: s.working_days },
        { formula: `${sumL(4)}4-${sumL(1)}4`, result: s.worked_days },
        { formula: `COUNTIF(${dayRow},"H")`, result: s.days_off },
    ].forEach((v, i) => {
        cell(4, sumCol + i).value = v;
        paint(cell(4, sumCol + i), { fill: C.header });
    });

    // ── row 5: daily strength. One employee per sheet, so it is 1 or 0. ──
    // The original's formulas, verbatim: B5 counts the employee row, and each
    // day counts that day's P - so picking P from a dropdown moves it.
    paint(cell(5, 1), { fill: C.header });
    cell(5, 2).value = { formula: "COUNTA(B4:B4)", result: 1 };
    paint(cell(5, 2), { fill: C.header });
    mergeStyled(ws, 5, 3, 5, 4, { fill: C.header, size: 14 }).value = "Daily Employee Strength";

    days.forEach((d, i) => {
        const c = cell(5, FIRST_DAY_COL + i);
        const col = colLetter(FIRST_DAY_COL + i);
        c.value = { formula: `COUNTIF(${col}4:${col}4, "P")`, result: dayVals[i] === "P" ? 1 : 0 };
        paint(c, { fill: C.header, size: 14 });
    });

    // The original carries the navy band across the summary columns on row 5
    // too, even though those cells are empty. Leaving them unfilled ends the
    // block in a ragged white notch under the summary.
    for (let i = 0; i < 7; i++) paint(cell(5, sumCol + i), { fill: C.header, size: 14 });

    // No frozen panes. The original has none, and a split at column D leaves a
    // hard rule down the sheet that reads as a border that should not be there.
    ws.views = [{ showGridLines: false }];

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
}

/** DZIND147_Attendance_Sheet_2026_09.xlsx */
const workbookFilename = (emp_id, year, month) =>
    `${emp_id}_Attendance_Sheet_${year}_${String(month).padStart(2, "0")}.xlsx`;

module.exports = { buildAttendanceWorkbook, workbookFilename, MONTHS };
