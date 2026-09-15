// Same shape as dAdmin's src/utils/api.js so the two apps stay familiar.
export const API_BASE =
    process.env.NODE_ENV === "production"
        ? process.env.REACT_APP_API
        : "http://localhost:4010";

// Profile photos are served by dAdmin, not by us - they belong to the employee
// record, so every dApp reads them from the same place. Same value dSlip uses.
export const EMP_PROFILE_FILE_BASE =
    process.env.NODE_ENV === "production"
        ? process.env.REACT_APP_EMP_PROFILE_FILE
        : "http://localhost:4002";

// dAdmin owns the global sign-in config (banners, rotation). Read-only,
// unauthenticated, read cross-origin from every dApp's sign-in screen.
//
// Deliberately NOT reached through apiFetch: that prefixes API_BASE, which is
// this app's own backend, and forces credentials: "include". There is no
// reason to send dAttendance's cookie to another app's domain.
export const DADMIN_API_BASE =
    process.env.NODE_ENV === "production"
        ? process.env.REACT_APP_DADMIN_API
        : "http://localhost:4002";

// An admin revoking someone in dAdmin now ends their session. The server
// answers 401 SESSION_REVOKED on the next request; without this the page would
// render broken data and leave the person apparently signed in.
//
// Handled here rather than per page so it cannot be forgotten by one caller.
// Guarded so a burst of parallel requests cannot cause a redirect loop.
//
// dAttendance differs from the suite snippet in ONE place: it does not skip
// /api/auth/*. The session check on every page load is GET /api/auth/me, which
// lives under that mount - skipping the prefix would swallow the revocation on
// every reload and drop the person on a bare sign-in form with no reason
// given. Ordinary sign-in 401s ("Invalid credentials" and the like) cannot
// trigger this anyway, because only verifyJWT ever answers SESSION_REVOKED.
// What IS skipped is being on the sign-in page itself - that page calls /me
// too, and that is where a redirect loop would actually come from.
const LOGIN_PATH = "/login";
let sessionEnded = false;

export async function apiFetch(endpoint, options = {}) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        credentials: "include",
        ...options,
    });

    if (res.status === 401 && !sessionEnded &&
        window.location.pathname.toLowerCase() !== LOGIN_PATH) {
        let message = "";
        // Read from a clone so the caller still gets an unconsumed body.
        try { message = (await res.clone().json())?.message || ""; } catch { /* not JSON */ }
        // Re-tested AFTER the await, not only before it. Parallel requests all
        // pass the check above while their bodies are still being read, so a
        // flag set only here would let every one of them redirect. Nothing can
        // interleave between this test and the set below, so this one holds.
        if (message === "SESSION_REVOKED" && !sessionEnded) {
            sessionEnded = true;
            window.location.replace(`${LOGIN_PATH}?revoked=1`);
        }
    }

    return res;
}

// Small helper so pages don't repeat the parse + error dance.
export async function apiJson(endpoint, options = {}) {
    const res = await apiFetch(endpoint, {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
        const err = new Error(data?.error || data?.message || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return data;
}
