// ============================================================================
//  Dev server launcher.
//
//  `react-scripts start` on an occupied port stops and ASKS whether to use a
//  different one, which blocks anything non-interactive and means a second
//  dApp already on :3000 leaves you staring at a prompt. This finds the first
//  free port from 3000 upward and hands it to react-scripts, so starting a
//  third or fourth dApp locally just works.
//
//  Production is unaffected - the droplet serves `npm run build` through nginx
//  and never runs this file.
//
//  The API server does NOT scan like this: its port is a fixed contract with
//  nginx and with REACT_APP_API, so a moving backend port would silently break
//  CORS and the cookie. Set DATTENDANCE_PORT in .env to move it deliberately.
// ============================================================================
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");

const FIRST_PORT = Number(process.env.PORT) || 3000;
const MAX_TRIES = 20;

// Every address a dev server on this machine might have bound. Checking only
// one is not enough: on Windows a listener on :: leaves 0.0.0.0 bindable and
// vice versa, so a single probe reports a busy port as free and react-scripts
// then stops to ask whether to move - the exact prompt this file exists to
// avoid. A tool bound to 127.0.0.1 only is invisible to both wildcards, hence
// the loopback entries too.
const PROBE_HOSTS = ["0.0.0.0", "::", "127.0.0.1", "::1"];

// Bind rather than connect. A connect probe reports "free" for a port held by
// a socket in TIME_WAIT, which react-scripts would then fail to bind anyway.
const canBind = (port, host) =>
    new Promise((resolve) => {
        const srv = net.createServer();
        srv.once("error", (err) => {
            // Only "someone already has it" means busy. EAFNOSUPPORT/EADDRNOTAVAIL
            // mean this machine has no such address family - not a conflict, and
            // treating it as one would make the scan walk past every free port.
            resolve(!(err.code === "EADDRINUSE" || err.code === "EACCES"));
        });
        srv.once("listening", () => srv.close(() => resolve(true)));
        srv.listen({ port, host, exclusive: true });
    });

const isFree = async (port) => {
    for (const host of PROBE_HOSTS) {
        if (!(await canBind(port, host))) return false;
    }
    return true;
};

(async () => {
    let port = null;
    for (let p = FIRST_PORT; p < FIRST_PORT + MAX_TRIES; p++) {
        if (await isFree(p)) { port = p; break; }
        console.log(`   port ${p} is busy`);
    }

    if (port === null) {
        console.error(
            `\n  No free port between ${FIRST_PORT} and ${FIRST_PORT + MAX_TRIES - 1}.` +
            `\n  Close something, or run: PORT=<port> npm start\n`
        );
        process.exit(1);
    }

    if (port !== FIRST_PORT) {
        console.log(`\n  Starting dAttendance on port ${port} instead of ${FIRST_PORT}.\n`);
    }

    // The API allows any localhost origin in development, so a shifted port
    // still passes CORS on credentialed requests. See server.js.
    const child = spawn(
        process.execPath,
        [path.join(__dirname, "..", "node_modules", "react-scripts", "bin", "react-scripts.js"), "start"],
        {
            stdio: "inherit",
            env: { ...process.env, PORT: String(port) },
        }
    );

    child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
})();
