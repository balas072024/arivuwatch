const express = require("express");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const crypto = require("crypto");
const { body, validationResult } = require("express-validator");
const { generateToken, authMiddleware, adminOnly } = require("./auth");

function createRoutes(db) {
  const router = express.Router();
  const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    next();
  };

  // ── Auth ──────────────────────────────────────────────
  router.post("/auth/login",
    body("username").trim().notEmpty().withMessage("Username required"),
    body("password").notEmpty().withMessage("Password required"),
    validate,
    (req, res) => {
      const user = db.prepare("SELECT * FROM users WHERE username = ?").get(req.body.username);
      if (!user || !bcrypt.compareSync(req.body.password, user.password_hash))
        return res.status(401).json({ error: "Invalid credentials" });
      res.json({ token: generateToken(user), user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
    }
  );

  router.get("/auth/me", authMiddleware, (req, res) => {
    const user = db.prepare("SELECT id, username, display_name, role FROM users WHERE id = ?").get(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  });

  // ── Services Status ───────────────────────────────────
  router.get("/status", authMiddleware, async (req, res) => {
    let services = db.prepare("SELECT * FROM services WHERE enabled = 1").all();
    if (services.length === 0) {
      // Default services if none configured
      services = [
        { name: "ClawArivu", host: "localhost", port: 18789, health_path: "/api/health" },
        { name: "Neural Brain", host: "localhost", port: 8200, health_path: "/health" },
        { name: "OpsShiftPro", host: "localhost", port: 4000, health_path: "/api/health" },
        { name: "Family Hub", host: "localhost", port: 3000, health_path: "/api/health" },
        { name: "Valluvan", host: "localhost", port: 5000, health_path: "/health" },
        { name: "Vault Browser", host: "localhost", port: 4100, health_path: "/api/health" },
      ];
    }

    const results = await Promise.all(services.map(async s => {
      const start = Date.now();
      try {
        await axios.get(`http://${s.host}:${s.port}${s.health_path}`, { timeout: 3000 });
        const latency = Date.now() - start;
        db.prepare("INSERT INTO incidents (service_name, status, latency) VALUES (?, 'up', ?)").run(s.name, latency);
        return { name: s.name, port: s.port, status: "up", latency };
      } catch {
        db.prepare("INSERT INTO incidents (service_name, status, latency) VALUES (?, 'down', NULL)").run(s.name);
        return { name: s.name, port: s.port, status: "down", latency: null };
      }
    }));
    res.json({ services: results, ts: Date.now() });
  });

  router.get("/status/history", authMiddleware, (req, res) => {
    const history = db.prepare(
      "SELECT service_name, status, latency, checked_at FROM incidents ORDER BY checked_at DESC LIMIT 200"
    ).all();
    res.json({ history });
  });

  // ── Services Config (Admin) ───────────────────────────
  router.post("/services", authMiddleware, adminOnly,
    body("name").trim().notEmpty(), body("port").isInt({ min: 1 }),
    validate,
    (req, res) => {
      const { name, host, port, health_path } = req.body;
      const r = db.prepare("INSERT INTO services (name, host, port, health_path) VALUES (?, ?, ?, ?)")
        .run(name, host || "localhost", port, health_path || "/health");
      res.status(201).json({ service: db.prepare("SELECT * FROM services WHERE id = ?").get(r.lastInsertRowid) });
    }
  );

  router.delete("/services/:id", authMiddleware, adminOnly, (req, res) => {
    db.prepare("DELETE FROM services WHERE id = ?").run(req.params.id);
    res.json({ message: "Deleted" });
  });

  // ── Notes ─────────────────────────────────────────────
  router.get("/notes", authMiddleware, (req, res) => {
    res.json({ notes: db.prepare("SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC").all() });
  });

  router.post("/notes", authMiddleware,
    body("title").trim().isLength({ min: 1, max: 300 }).withMessage("Title required (max 300)"),
    body("content").optional().trim().isLength({ max: 10000 }),
    validate,
    (req, res) => {
      const { title, content, tags = [], pinned = 0 } = req.body;
      const r = db.prepare("INSERT INTO notes (title, content, tags, pinned, created_by) VALUES (?, ?, ?, ?, ?)")
        .run(title, content || "", JSON.stringify(tags), pinned ? 1 : 0, req.user.id);
      res.status(201).json({ note: db.prepare("SELECT * FROM notes WHERE id = ?").get(r.lastInsertRowid) });
    }
  );

  router.put("/notes/:id", authMiddleware,
    body("title").trim().isLength({ min: 1, max: 300 }),
    validate,
    (req, res) => {
      const { title, content, tags, pinned } = req.body;
      const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
      if (!note) return res.status(404).json({ error: "Note not found" });
      db.prepare("UPDATE notes SET title=?, content=?, tags=?, pinned=?, updated_at=datetime('now') WHERE id=?")
        .run(title || note.title, content ?? note.content, JSON.stringify(tags || JSON.parse(note.tags)), pinned !== undefined ? (pinned ? 1 : 0) : note.pinned, req.params.id);
      res.json({ note: db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id) });
    }
  );

  router.delete("/notes/:id", authMiddleware, (req, res) => {
    db.prepare("DELETE FROM notes WHERE id = ?").run(req.params.id);
    res.json({ message: "Deleted" });
  });

  // ── Todos ─────────────────────────────────────────────
  router.get("/todos", authMiddleware, (req, res) => {
    res.json({ todos: db.prepare("SELECT * FROM todos ORDER BY done ASC, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC").all() });
  });

  router.post("/todos", authMiddleware,
    body("title").trim().isLength({ min: 1, max: 500 }).withMessage("Title required"),
    body("priority").optional().isIn(["low", "normal", "high", "urgent"]),
    validate,
    (req, res) => {
      const { title, priority = "normal", due_at } = req.body;
      const r = db.prepare("INSERT INTO todos (title, priority, due_at, created_by) VALUES (?, ?, ?, ?)")
        .run(title, priority, due_at || null, req.user.id);
      res.status(201).json({ todo: db.prepare("SELECT * FROM todos WHERE id = ?").get(r.lastInsertRowid) });
    }
  );

  router.put("/todos/:id/toggle", authMiddleware, (req, res) => {
    const t = db.prepare("SELECT done FROM todos WHERE id = ?").get(req.params.id);
    if (!t) return res.status(404).json({ error: "Not found" });
    db.prepare("UPDATE todos SET done = ? WHERE id = ?").run(t.done ? 0 : 1, req.params.id);
    res.json({ todo: db.prepare("SELECT * FROM todos WHERE id = ?").get(req.params.id) });
  });

  router.delete("/todos/:id", authMiddleware, (req, res) => {
    db.prepare("DELETE FROM todos WHERE id = ?").run(req.params.id);
    res.json({ message: "Deleted" });
  });

  // ── AI Ask ────────────────────────────────────────────
  router.post("/ask", authMiddleware,
    body("question").trim().isLength({ min: 1, max: 2000 }).withMessage("Question required (max 2000 chars)"),
    validate,
    async (req, res) => {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) return res.status(503).json({ error: "AI service not configured. Set MINIMAX_API_KEY in .env" });
      try {
        const r = await axios.post("https://api.minimax.io/anthropic/v1/messages",
          { model: "MiniMax-M2.5", max_tokens: 512, messages: [{ role: "user", content: req.body.question }] },
          { headers: { "x-api-key": apiKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, timeout: 30000 }
        );
        res.json({ answer: r.data.content?.find(c => c.type === "text")?.text || "No response" });
      } catch (e) {
        res.status(502).json({ error: "AI service error: " + (e.response?.data?.error?.message || e.message) });
      }
    }
  );

  // ── Health ────────────────────────────────────────────
  router.get("/health", (req, res) => {
    res.json({ status: "ok", service: "arivuwatch", uptime: process.uptime() });
  });

  return router;
}

module.exports = { createRoutes };
