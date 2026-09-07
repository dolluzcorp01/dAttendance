// ============================================================================
//  dAttendance - employee app server
//  Port 4010 (dAdmin 4002, dAssist 4001, dTime 4003, dBug 4004, dSlip 4007).
//
//  Hardcoded, the same way every other dApp does it - .env carries the domain,
//  not the local port. Change it here and in the nginx proxy_pass together;
//  nginx proxies dattendance.dolluzcorp.com to this port.
// ============================================================================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");

const app = express();
const port = 4010;

const isProd = process.env.NODE_ENV === "production";

// Credentialed requests need an explicit origin - '*' is rejected by the
// browser when credentials: 'include' is set.
const allowedOrigins = [
    "https://dattendance.dolluzcorp.com",
    "https://dadmin.dolluzcorp.com",
    "https://inside.dolluzcorp.com",
    "https://dolluzcorp.com",
];
const isLocalhostOrigin = (origin) =>
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const clean = origin.replace(/\/$/, "");
        if (allowedOrigins.includes(clean)) return callback(null, true);
        if (!isProd && isLocalhostOrigin(clean)) return callback(null, true);
        console.error("❌ Blocked by CORS:", origin);
        return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    exposedHeaders: ["Content-Disposition"],
}));

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(cookieParser());

// Behind nginx, so req.ip is the proxy unless we trust it. The activity log
// records req.ip, and a log full of 127.0.0.1 is worthless.
app.set("trust proxy", 1);

const LoginRoutes = require("./src/backend_routes/Login_server");
const SheetRoutes = require("./src/backend_routes/dAttendance_Sheet_server");
const EmployeeRoutes = require("./src/backend_routes/Employee_server");

app.use("/api/auth", LoginRoutes.router);
app.use("/api/sheet", SheetRoutes);
app.use("/api/employee", EmployeeRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true, app: "dAttendance", port }));

// Express 5 - an error handler must take four arguments or it is treated as
// ordinary middleware and never runs.
app.use((err, req, res, next) => {
    console.error("[dAttendance] unhandled:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
    console.log(`🚀 dAttendance server running at http://localhost:${port}`);
});
