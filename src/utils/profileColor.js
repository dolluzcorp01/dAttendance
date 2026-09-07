// Profile-color helper - generates a deterministic HSL color from a name string.
//
// Copied from dAdmin's src/utils/profileColor.js so one employee gets the SAME
// avatar colour everywhere in the suite. There are now four copies of this
// algorithm, and they must not drift:
//
//   dAdmin  src/utils/profileColor.js                    (client)
//   dAdmin  src/backend_routes/Employee_server.js        (generateColorFromText)
//   dSlip   src/backend_routes/Employee_server.js        (generateColorFromText)
//   here    this file, and Login_server.js's /api/auth/me
//
// THE SEED MATTERS AS MUCH AS THE FORMULA. Every caller across the suite hashes
// `emp_first_name` - title-cased, first two words - not the full name. Hashing
// "Pavithran V V" instead of "Pavithran" is still deterministic and still
// pretty, it is just a different colour from the one dAdmin shows for the same
// person. dAttendance's /api/auth/me returns emp_first_name already title-cased
// for exactly this reason, so passing it straight in here is correct.
//
// Lightness locked at 60% guarantees white text on the circle stays readable
// regardless of which hue lands.
//
// KNOWN QUIRK, inherited and deliberately preserved: this client helper trims
// the name, the backend generators do not. So a stored name with stray
// whitespace - "Pavithran " - hashes differently here than on the server.
// dAdmin has exactly the same split between its util and its Employee_server,
// so matching it is what keeps the suite consistent; "fixing" it here would
// make dAttendance the odd one out. Every real name in dadmin.employee is
// cleanly single-spaced, so the two forms agree in practice. If a padded name
// ever gets typed in, clean the DB rather than changing this function.
export function profileColorFromName(name) {
    const text = String(name || "").trim() || "User";
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    return `hsl(${hue}, 70%, 60%)`;
}

// Convenience: returns up to two-letter initials from a "First Last" pair.
// Falls back gracefully when one or both names are missing.
export function initialsFromName(first, last) {
    const a = String(first || "").trim().charAt(0).toUpperCase();
    const b = String(last || "").trim().charAt(0).toUpperCase();
    return (a + b) || "?";
}

// The top-nav avatar shows ONE letter, matching dAdmin's left navbar, so this
// is what TopNavbar uses rather than initialsFromName.
export function initialFromName(first) {
    return String(first || "").trim().charAt(0).toUpperCase() || "?";
}
