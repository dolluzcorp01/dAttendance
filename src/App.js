import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { SessionProvider, ProtectedRoute } from "./utils/SessionContext";
import Login from "./Login";
import MyAttendance from "./My_Attendance";
import "./App.css";

export default function App() {
    return (
        <SessionProvider>
            <Routes>
                <Route path="/" element={<Navigate to="/attendance" replace />} />
                <Route path="/login" element={<Login />} />
                <Route
                    path="/attendance"
                    element={
                        <ProtectedRoute>
                            <MyAttendance />
                        </ProtectedRoute>
                    }
                />
                <Route path="*" element={<Navigate to="/attendance" replace />} />
            </Routes>
        </SessionProvider>
    );
}
