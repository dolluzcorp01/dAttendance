// Same shape as dAdmin's src/utils/api.js so the two apps stay familiar.
export const API_BASE =
    process.env.NODE_ENV === "production"
        ? process.env.REACT_APP_API
        : "http://localhost:4010";

export async function apiFetch(endpoint, options = {}) {
    return fetch(`${API_BASE}${endpoint}`, {
        credentials: "include",
        ...options,
    });
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
