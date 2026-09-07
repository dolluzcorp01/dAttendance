// ============================================================================
//  dAttendance - the employee's own profile photo.
//
//  Mount:  app.use("/api/employee", EmployeeRoutes);
//
//  A trimmed copy of dSlip's Employee_server.js, carrying only the one endpoint
//  the top-nav avatar needs. Identical contract, so the two apps behave the
//  same: multipart field "profile", replies { profilePath }.
//
//  WHERE THE FILE GOES
//  -------------------
//  Into dAdmin's User_profile_file_uploads folder, which dAdmin serves
//  statically - the same folder dSlip writes to. The photo belongs to the
//  employee record, not to this app, so a photo set here shows up in dSlip and
//  dAdmin too. EMP_PROFILE_UPLOAD_PATH points at that folder.
//
//  The DB stores a web-relative path, never the physical one, so the folder can
//  move hosts without rewriting history. The frontend prefixes it with
//  EMP_PROFILE_FILE_BASE.
// ============================================================================
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const router = express.Router();

const getDBConnection = require("../../config/db");
const { verifyJWT } = require("./Login_server");

const dadmin = getDBConnection("dadmin");
const UPLOAD_DIR = process.env.EMP_PROFILE_UPLOAD_PATH;

// 0.5 MB, matching what the modal tells the employee. multer rejects anything
// larger before it reaches disk - the client-side check is a courtesy, not a
// control.
const MAX_BYTES = 0.5 * 1024 * 1024;

const profileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            if (!UPLOAD_DIR) return cb(new Error("EMP_PROFILE_UPLOAD_PATH is not set"));
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
            cb(null, UPLOAD_DIR);
        },
        // emp_id comes from verifyJWT, which runs before multer - so a client
        // cannot choose whose photo it overwrites by naming the file.
        filename: (req, file, cb) =>
            cb(null, `${req.emp_id}-${Date.now()}${path.extname(file.originalname)}`),
    }),
    limits: { fileSize: MAX_BYTES },
    fileFilter: (req, file, cb) => {
        if (!/^image\//.test(file.mimetype)) return cb(new Error("Only image files are allowed"));
        cb(null, true);
    },
});

// ---------------------------------------------------------------------------
// POST /upload-profile   multipart, field "profile"  ->  { profilePath }
// ---------------------------------------------------------------------------
router.post("/upload-profile", verifyJWT, (req, res) => {
    profileUpload.single("profile")(req, res, (uploadErr) => {
        if (uploadErr) {
            const tooBig = uploadErr.code === "LIMIT_FILE_SIZE";
            return res.status(400).json({
                error: tooBig ? "Please choose an image under 0.5 MB." : uploadErr.message,
            });
        }
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const empId = req.emp_id;
        const relativePath = `User_profile_file_uploads/${req.file.filename}`;

        // Drop this employee's older photos so the folder does not grow a file
        // per upload forever. Best effort - a failure here must not fail the
        // upload that already succeeded.
        try {
            if (UPLOAD_DIR && fs.existsSync(UPLOAD_DIR)) {
                for (const f of fs.readdirSync(UPLOAD_DIR)) {
                    if (f.startsWith(`${empId}-`) && f !== req.file.filename) {
                        fs.unlinkSync(path.join(UPLOAD_DIR, f));
                    }
                }
            }
        } catch (err) {
            console.error("[dAttendance/upload-profile] cleanup failed:", err.message);
        }

        dadmin.query(
            `UPDATE employee SET emp_profile_img = ?, updated_time = NOW()
              WHERE emp_id = ? AND deleted_time IS NULL`,
            [relativePath, empId],
            (err) => {
                if (err) {
                    console.error("[dAttendance/upload-profile]", err);
                    return res.status(500).json({ error: "Database error" });
                }
                res.json({ success: true, profilePath: relativePath });
            }
        );
    });
});

module.exports = router;
