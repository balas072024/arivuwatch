require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { getDb, initDb } = require("./db");
const { createRoutes } = require("./routes");

const PORT = parseInt(process.env.PORT) || 9000;
const db = getDb();
initDb(db);

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://api.minimax.io"],
      imgSrc: ["'self'", "data:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: "Too many requests" } }));
app.use("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many login attempts" } }));
app.use("/api/ask", rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: "AI rate limit reached, wait a moment" } }));

app.use("/api", createRoutes(db));
app.use(express.static(path.join(__dirname, "../../public")));
app.get("/{*path}", (req, res) => res.sendFile(path.join(__dirname, "../../public/index.html")));

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  🦅 ArivuWatch running at http://localhost:${PORT}\n`);
  });
}

module.exports = { app, server, db };
