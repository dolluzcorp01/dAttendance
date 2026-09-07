// ============================================================================
//  dAttendance - the top-nav profile chip.
//
//  Ported from dSlip's src/TopNavbar.js so the two apps behave identically:
//  same avatar rules, same dropdown, same upload modal, same class names.
//
//  It renders only the RIGHT-HAND side of the bar, not the whole bar. dSlip's
//  TopNavbar owns its navbar because dSlip has section tabs and a command
//  palette in it; dAttendance's bar already carries the brand and the server
//  date, so this drops into the existing header rather than replacing it.
//
//  Differences from dSlip, all forced by dAttendance's own backend:
//    - logout posts to /api/auth/logout   (dSlip: /api/login/logout)
//    - the employee comes from SessionContext, filled by /api/auth/me
//      (dSlip: /api/employee/logined_employee)
//    - "Change Password" opens /login?changePassword, which dAttendance's login
//      page reads to jump straight into its email -> code -> new password flow
// ============================================================================
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Swal from "sweetalert2";
import { apiFetch, EMP_PROFILE_FILE_BASE } from "./utils/api";
import "./TopNavbar.css";

export default function TopNavbar({ loggedInEmp, setLoggedInEmp }) {
    const dropdownRef = useRef(null);
    const fileInputRef = useRef(null);

    const [dropOpen, setDropOpen] = useState(false);
    const [copiedEmail, setCopiedEmail] = useState(null);
    const [profileModal, setProfileModal] = useState(false);
    const [selectedFile, setSelectedFile] = useState(null);
    const [saving, setSaving] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);

    // Revoke the previous object URL on change, or every pick leaks one.
    useEffect(() => {
        if (!selectedFile) { setPreviewUrl(null); return undefined; }
        const url = URL.createObjectURL(selectedFile);
        setPreviewUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [selectedFile]);

    // Close the dropdown on outside click.
    useEffect(() => {
        const handler = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    // ── Logout ───────────────────────────────────────────────
    const handleLogout = async () => {
        setDropOpen(false);
        try {
            await apiFetch("/api/auth/logout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Keep the remembered browser - signing out is not "forget me".
                body: JSON.stringify({ forget: false }),
            });
        } catch { /* clear the client side regardless */ }
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = "/login";
    };

    // ── Copy email - custom toast, not sweetalert ────────────
    const handleCopyEmail = (email) => {
        navigator.clipboard.writeText(email)
            .then(() => {
                setCopiedEmail(email);
                clearTimeout(handleCopyEmail._t);
                handleCopyEmail._t = setTimeout(() => setCopiedEmail(null), 1900);
            })
            .catch(() => {});
        setDropOpen(false);
    };

    // ── Profile image upload ─────────────────────────────────
    const MAX_SIZE = 0.5 * 1024 * 1024;

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > MAX_SIZE) {
            Swal.fire({ icon: "warning", title: "File Too Large", text: "Please select an image under 0.5 MB." });
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }
        setSelectedFile(file);
    };

    const handleSaveProfile = async () => {
        if (!selectedFile) return;
        setSaving(true);
        const form = new FormData();
        form.append("profile", selectedFile);
        try {
            const res = await apiFetch("/api/employee/upload-profile", { method: "POST", body: form });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Upload failed");
            Swal.fire({ icon: "success", title: "Profile Updated!", timer: 1400, showConfirmButton: false });
            // Update in memory so the avatar changes at once, with no refetch.
            setLoggedInEmp((prev) => ({ ...prev, emp_profile_img: data.profilePath }));
            setProfileModal(false);
            setSelectedFile(null);
        } catch (err) {
            Swal.fire({ icon: "error", title: "Error", text: err.message });
        } finally {
            setSaving(false);
        }
    };

    // ── Avatar background helper ─────────────────────────────
    // A photo when there is one, otherwise a colour derived from the name.
    // profile_color / profile_letters are computed server-side in /api/auth/me
    // using dSlip's generator, so the same person is the same colour in both.
    const avatarStyle = (emp) => {
        if (!emp) return { backgroundColor: "#E8520A" };
        if (emp.emp_profile_img) {
            const url = emp.emp_profile_img.startsWith("data:")
                ? emp.emp_profile_img
                : `${EMP_PROFILE_FILE_BASE}/${emp.emp_profile_img.replace(/\\/g, "/")}`;
            return { backgroundImage: `url(${url})`, backgroundColor: "transparent" };
        }
        return { backgroundColor: emp.profile_color || "#E8520A" };
    };

    const initials = loggedInEmp
        ? (loggedInEmp.profile_letters || (loggedInEmp.emp_first_name?.[0] || "").toUpperCase())
        : "?";

    const fullName = loggedInEmp
        ? `${loggedInEmp.emp_first_name || ""} ${loggedInEmp.emp_last_name || ""}`.trim()
          || loggedInEmp.emp_name
        : "";

    const role = [loggedInEmp?.job_name, loggedInEmp?.emp_location].filter(Boolean).join(" · ");

    return (
        <>
            <div className="dz-topnav-right" ref={dropdownRef} onClick={() => setDropOpen((o) => !o)}>
                {loggedInEmp && (
                    <div className="dz-topnav-name">
                        <span className="tn-fullname">{fullName}</span>
                        <span className="tn-tagline">{role || "One Place. One Start. One Team."}</span>
                    </div>
                )}
                <div className="dz-topnav-avatar" style={avatarStyle(loggedInEmp)}>
                    {!loggedInEmp?.emp_profile_img && initials}
                </div>
                <span className={`dz-topnav-chevron ${dropOpen ? "open" : ""}`}>▾</span>

                {dropOpen && (
                    <div className="dz-topnav-dropdown" onClick={(e) => e.stopPropagation()}>
                        <div className="tn-drop-profile">
                            <div
                                className="tn-drop-profile-avatar"
                                style={avatarStyle(loggedInEmp)}
                                onClick={() => { setProfileModal(true); setDropOpen(false); }}
                                title="Change profile photo"
                            >
                                {!loggedInEmp?.emp_profile_img && initials}
                            </div>
                            <div className="tn-drop-profile-text">
                                <div className="tn-drop-name">{fullName}</div>
                                <div className="tn-drop-tagline">
                                    {loggedInEmp?.emp_mail_id || "One Place. One Start. One Team."}
                                </div>
                            </div>
                        </div>

                        <button
                            type="button"
                            className="tn-drop-item"
                            onClick={() => handleCopyEmail("hr@dolluzcorp.com")}
                            title="Copy HR email"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
                                <rect x="2.5" y="13" width="4" height="6" rx="1.5" />
                                <rect x="17.5" y="13" width="4" height="6" rx="1.5" />
                                <path d="M20 19v.5a3 3 0 0 1-3 3h-3" />
                            </svg>
                            hr@dolluzcorp.com
                        </button>

                        <a className="tn-drop-item" href="/login?changePassword" onClick={() => setDropOpen(false)}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="7.5" cy="15.5" r="4" />
                                <path d="M10.4 12.6 20 3M16.5 6.5l2 2M13.5 9.5l2 2" />
                            </svg>
                            Change Password
                        </a>

                        <div className="tn-drop-divider" />

                        <button type="button" className="tn-drop-item danger" onClick={handleLogout}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
                                <path d="M10 17l-5-5 5-5" />
                                <path d="M4.5 12H16" />
                            </svg>
                            Logout
                        </button>
                    </div>
                )}
            </div>

            {/* Profile photo upload modal */}
            {profileModal && createPortal(
                <div className="tn-profile-modal-overlay" onClick={() => { setProfileModal(false); setSelectedFile(null); }}>
                    <div className="tn-profile-modal" onClick={(e) => e.stopPropagation()}>
                        <button className="tn-profile-modal-close" onClick={() => { setProfileModal(false); setSelectedFile(null); }}>✕</button>
                        <h3>Update Profile Photo</h3>

                        {selectedFile ? (
                            <img src={previewUrl} alt="Preview" className="tn-profile-preview" />
                        ) : (
                            <div className="tn-profile-placeholder">📷</div>
                        )}

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleFileChange}
                            style={{ width: "100%" }}
                        />

                        <div className="tn-profile-modal-btns">
                            <button className="tn-btn-cancel" onClick={() => { setProfileModal(false); setSelectedFile(null); }}>
                                Cancel
                            </button>
                            <button className="tn-btn-save" onClick={handleSaveProfile} disabled={!selectedFile || saving}>
                                {saving ? "Saving…" : "Save"}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {copiedEmail && createPortal(
                <div className="tn-copy-toast">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                    {copiedEmail} copied
                </div>,
                document.body
            )}
        </>
    );
}
