require("dotenv").config();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getDb, initDb } = require("./db");

const db = getDb();
initDb(db);

const users = [
  { username: "admin", display_name: "Admin", role: "admin", password: "Watch@2024" },
  { username: "viewer", display_name: "Viewer", role: "viewer", password: "Watch@2024" },
];

const insert = db.prepare("INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)");
for (const u of users) {
  insert.run(crypto.randomUUID(), u.username, u.display_name, u.role, bcrypt.hashSync(u.password, 10));
}

console.log("✅ ArivuWatch seed complete. Default password: Watch@2024");
db.close();
