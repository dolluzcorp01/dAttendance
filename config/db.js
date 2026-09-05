// Identical to dAdmin's config/db.js so both apps pool the same way.
// One pool per database name, created lazily.
const mysql = require('mysql2');

const pools = {};

function getDBConnection(database) {
    if (!pools[database]) {
        pools[database] = mysql.createPool({
            connectionLimit: 50,
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: database,
            waitForConnections: true,
            queueLimit: 1000,
            multipleStatements: true,
            charset: "utf8mb4",
            timezone: "+05:30",
            dateStrings: ["DATE"],
        });
        console.log(`🔗 Created new connection pool for database: ${database}`);
    }
    return pools[database];
}

module.exports = getDBConnection;
