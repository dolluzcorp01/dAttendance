// ============================================================================
//  Session for the employee app.
//
//  Deliberately much smaller than dAdmin's AccessContext: there is no access
//  matrix here. Every employee sees exactly one page - their own attendance -
//  and the server scopes every query to req.emp_id from the JWT. So the only
//  question this context answers is "is someone logged in, and who".
// ============================================================================
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "./api";

const SessionContext = createContext({
    employee: null, setEmployee: () => {}, ready: false,
    refetch: async () => {}, logout: async () => {},
});

export function SessionProvider({ children }) {
    const [employee, setEmployee] = useState(null);
    const [ready, setReady] = useState(false);

    const refetch = useCallback(async () => {
        setReady(false);
        try {
            const res = await apiFetch("/api/auth/me");
            const data = await res.json();
            setEmployee(res.ok && data?.success ? data.employee : null);
        } catch {
            setEmployee(null);
        } finally {
            setReady(true);
        }
    }, []);

    useEffect(() => { refetch(); }, [refetch]);

    const logout = useCallback(async () => {
        try { await apiFetch("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
        setEmployee(null);
    }, []);

    // setEmployee is exposed so a profile-photo upload can refresh the avatar
    // without a round trip to /me.
    const value = useMemo(
        () => ({ employee, setEmployee, ready, refetch, logout }),
        [employee, ready, refetch, logout]);
    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

// Route guard. Renders nothing while the /me call is in flight, so a logged-in
// user never sees a flash of the login page on refresh.
export function ProtectedRoute({ children }) {
    const { employee, ready } = useSession();
    const navigate = useNavigate();

    useEffect(() => {
        if (ready && !employee) navigate("/login", { replace: true });
    }, [ready, employee, navigate]);

    if (!ready) return null;
    if (!employee) return null;
    return children;
}
