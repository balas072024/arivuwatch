const request = require("supertest");
const path = require("path");
const fs = require("fs");

const TEST_DB = path.join(__dirname, "../../data/test.db");
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = "test-secret";

const { getDb, initDb } = require("../src/db");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

let app, server, db, adminToken, viewerToken;

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  db = getDb(); initDb(db);
  const adminId = crypto.randomUUID();
  const viewerId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,username,display_name,role,password_hash) VALUES (?,?,?,?,?)")
    .run(adminId, "admin", "Admin", "admin", bcrypt.hashSync("admin123", 10));
  db.prepare("INSERT INTO users (id,username,display_name,role,password_hash) VALUES (?,?,?,?,?)")
    .run(viewerId, "viewer", "Viewer", "viewer", bcrypt.hashSync("viewer123", 10));
  const mod = require("../src/index");
  app = mod.app; server = mod.server;
});

afterAll(() => {
  if (db) db.close();
  if (server) server.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("Auth", () => {
  test("POST /api/auth/login - admin", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe("admin");
    adminToken = res.body.token;
  });

  test("POST /api/auth/login - viewer", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "viewer", password: "viewer123" });
    expect(res.status).toBe(200);
    viewerToken = res.body.token;
  });

  test("POST /api/auth/login - wrong password", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "wrong" });
    expect(res.status).toBe(401);
  });

  test("GET /api/auth/me - returns user", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("admin");
  });

  test("Rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/notes");
    expect(res.status).toBe(401);
  });
});

describe("Notes", () => {
  let noteId;
  test("POST /api/notes - create", async () => {
    const res = await request(app).post("/api/notes").set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Test Note", content: "Hello", tags: ["test"] });
    expect(res.status).toBe(201);
    expect(res.body.note.title).toBe("Test Note");
    noteId = res.body.note.id;
  });

  test("POST /api/notes - rejects empty title", async () => {
    const res = await request(app).post("/api/notes").set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "" });
    expect(res.status).toBe(400);
  });

  test("GET /api/notes - list", async () => {
    const res = await request(app).get("/api/notes").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.notes.length).toBeGreaterThanOrEqual(1);
  });

  test("PUT /api/notes/:id - update", async () => {
    const res = await request(app).put(`/api/notes/${noteId}`).set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Updated", content: "Updated content", pinned: true });
    expect(res.status).toBe(200);
    expect(res.body.note.title).toBe("Updated");
    expect(res.body.note.pinned).toBe(1);
  });

  test("DELETE /api/notes/:id", async () => {
    const res = await request(app).delete(`/api/notes/${noteId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe("Todos", () => {
  let todoId;
  test("POST /api/todos - create", async () => {
    const res = await request(app).post("/api/todos").set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Fix bug", priority: "high" });
    expect(res.status).toBe(201);
    expect(res.body.todo.priority).toBe("high");
    todoId = res.body.todo.id;
  });

  test("POST /api/todos - rejects empty", async () => {
    const res = await request(app).post("/api/todos").set("Authorization", `Bearer ${adminToken}`).send({ title: "" });
    expect(res.status).toBe(400);
  });

  test("GET /api/todos", async () => {
    const res = await request(app).get("/api/todos").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.todos.length).toBeGreaterThanOrEqual(1);
  });

  test("PUT /api/todos/:id/toggle", async () => {
    const res = await request(app).put(`/api/todos/${todoId}/toggle`).set("Authorization", `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.todo.done).toBe(1);
  });

  test("DELETE /api/todos/:id", async () => {
    const res = await request(app).delete(`/api/todos/${todoId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe("Services", () => {
  test("POST /api/services - admin can add", async () => {
    const res = await request(app).post("/api/services").set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "TestService", port: 9999, health_path: "/health" });
    expect(res.status).toBe(201);
  });

  test("POST /api/services - viewer cannot add", async () => {
    const res = await request(app).post("/api/services").set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "Hack", port: 1234 });
    expect(res.status).toBe(403);
  });

  test("GET /api/status - checks services", async () => {
    const res = await request(app).get("/api/status").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.services).toBeDefined();
    expect(Array.isArray(res.body.services)).toBe(true);
  });

  test("GET /api/status/history", async () => {
    const res = await request(app).get("/api/status/history").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });
});

describe("AI Ask", () => {
  test("POST /api/ask - requires API key", async () => {
    const res = await request(app).post("/api/ask").set("Authorization", `Bearer ${adminToken}`)
      .send({ question: "Hello" });
    // Should return 503 since no API key in test
    expect(res.status).toBe(503);
  });

  test("POST /api/ask - rejects empty question", async () => {
    const res = await request(app).post("/api/ask").set("Authorization", `Bearer ${adminToken}`)
      .send({ question: "" });
    expect(res.status).toBe(400);
  });
});

describe("Health", () => {
  test("GET /api/health - no auth needed", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
