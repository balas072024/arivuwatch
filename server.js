'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = 9000;
const DB_PATH = path.join(__dirname, 'data', 'arivuwatch.db');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    content TEXT, tags TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    done INTEGER DEFAULT 0, priority TEXT DEFAULT 'normal',
    due_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SERVICES = [
  { name: 'ClawArivu',    port: 18789, path: '/api/health' },
  { name: 'Neural Brain', port: 8200,  path: '/health' },
  { name: 'OpsShiftPro',  port: 4000,  path: '/api/health' },
  { name: 'OpsWatch',     port: 3001,  path: '/health' },
  { name: 'Valluvan',     port: 5000,  path: '/health' },
  { name: 'KaasAI',       port: 3000,  path: '/health' },
  { name: 'Vault',        port: 4100,  path: '/api/health' },
];

app.get('/api/status', async (req, res) => {
  const results = await Promise.all(SERVICES.map(async s => {
    const start = Date.now();
    try { await axios.get(`http://localhost:${s.port}${s.path}`, { timeout: 3000 }); return { ...s, status: 'up', latency: Date.now() - start }; }
    catch { return { ...s, status: 'down', latency: null }; }
  }));
  res.json({ services: results, ts: Date.now() });
});

app.get('/api/notes', (req, res) => res.json({ notes: db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC').all() }));
app.post('/api/notes', (req, res) => {
  const { title, content, tags = [], pinned = 0 } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title required' });
  const r = db.prepare('INSERT INTO notes (title,content,tags,pinned) VALUES (?,?,?,?)').run(title, content||'', JSON.stringify(tags), pinned?1:0);
  res.json({ note: db.prepare('SELECT * FROM notes WHERE id=?').get(r.lastInsertRowid) });
});
app.put('/api/notes/:id', (req, res) => {
  const { title, content, tags, pinned } = req.body || {};
  db.prepare('UPDATE notes SET title=?,content=?,tags=?,pinned=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(title, content, JSON.stringify(tags||[]), pinned?1:0, req.params.id);
  res.json({ note: db.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id) });
});
app.delete('/api/notes/:id', (req, res) => { db.prepare('DELETE FROM notes WHERE id=?').run(req.params.id); res.json({ success: true }); });

app.get('/api/todos', (req, res) => res.json({ todos: db.prepare('SELECT * FROM todos ORDER BY done ASC, created_at DESC').all() }));
app.post('/api/todos', (req, res) => {
  const { title, priority = 'normal', due_at } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title required' });
  const r = db.prepare('INSERT INTO todos (title,priority,due_at) VALUES (?,?,?)').run(title, priority, due_at||null);
  res.json({ todo: db.prepare('SELECT * FROM todos WHERE id=?').get(r.lastInsertRowid) });
});
app.put('/api/todos/:id/toggle', (req, res) => {
  const t = db.prepare('SELECT done FROM todos WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE todos SET done=? WHERE id=?').run(t.done?0:1, req.params.id);
  res.json({ todo: db.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id) });
});
app.delete('/api/todos/:id', (req, res) => { db.prepare('DELETE FROM todos WHERE id=?').run(req.params.id); res.json({ success: true }); });

app.post('/api/ask', async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Question required' });
  try {
    const r = await axios.post('https://api.minimax.io/anthropic/v1/messages',
      { model:'MiniMax-M2.5', max_tokens:512, messages:[{role:'user',content:question}] },
      { headers:{'x-api-key':process.env.MINIMAX_API_KEY,'Content-Type':'application/json','anthropic-version':'2023-06-01'}, timeout:30000 });
    const text = r.data.content?.find(c=>c.type==='text')?.text || '';
    res.json({ answer: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'arivuwatch', port: PORT }));

app.get('/', (req, res) => res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ArivuWatch</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#07070f;color:#e2e8f0;font-family:"Segoe UI",sans-serif;padding:20px}
h1{font-size:22px;color:#c4b5fd;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:20px}
.card{background:#0d0d1a;border:1px solid rgba(124,107,255,.2);border-radius:12px;padding:16px}
.card h3{font-size:13px;color:#94a3b8;margin-bottom:8px}
.status{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%}.up{background:#22c55e}.down{background:#ef4444}
.section{background:#0d0d1a;border:1px solid rgba(124,107,255,.2);border-radius:12px;padding:20px;margin-bottom:16px}
.section h2{font-size:16px;font-weight:600;color:#c4b5fd;margin-bottom:14px}
input{width:100%;padding:10px;background:#07070f;border:1px solid rgba(124,107,255,.3);border-radius:8px;color:#e2e8f0;font-size:14px;font-family:inherit;outline:none;margin-bottom:8px}
button{padding:8px 16px;background:#7c6bff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
.todo-item{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px}
.done{text-decoration:line-through;opacity:.5}
</style></head><body>
<h1>🦅 ArivuWatch</h1>
<div id="services" class="grid"></div>
<div class="section"><h2>✅ Todos</h2>
<div style="display:flex;gap:8px;margin-bottom:12px">
<input type="text" id="todo-input" placeholder="Add todo..." style="margin:0" onkeydown="if(event.key==='Enter')addTodo()">
<button onclick="addTodo()">Add</button></div>
<div id="todos-list"></div></div>
<div class="section"><h2>📝 Notes</h2>
<input type="text" id="note-title" placeholder="Title...">
<input type="text" id="note-content" placeholder="Content...">
<button onclick="addNote()">Save</button>
<div id="notes-list" style="margin-top:12px"></div></div>
<div class="section"><h2>🤖 Ask Arivu</h2>
<div style="display:flex;gap:8px">
<input type="text" id="ask-input" placeholder="Ask anything..." style="margin:0" onkeydown="if(event.key==='Enter')askArivu()">
<button onclick="askArivu()">Ask</button></div>
<div id="ask-result" style="margin-top:12px;font-size:14px;color:#94a3b8;line-height:1.6"></div></div>
<script>
async function api(url,opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opts});return r.json();}
async function loadStatus(){const{services}=await api('/api/status');document.getElementById('services').innerHTML=services.map(s=>`<div class="card"><h3>${s.name}</h3><div class="status"><div class="dot ${s.status}"></div><span>${s.status.toUpperCase()}</span>${s.latency?'<span style="color:#64748b;font-size:12px"> '+s.latency+'ms</span>':''}</div><div style="font-size:12px;color:#475569;margin-top:4px">:${s.port}</div></div>`).join('');}
async function loadTodos(){const{todos}=await api('/api/todos');document.getElementById('todos-list').innerHTML=todos.map(t=>`<div class="todo-item"><input type="checkbox" ${t.done?'checked':''} onchange="toggleTodo(${t.id})"><span class="${t.done?'done':''}">${t.title}</span></div>`).join('');}
async function addTodo(){const i=document.getElementById('todo-input');if(!i.value.trim())return;await api('/api/todos',{method:'POST',body:JSON.stringify({title:i.value.trim()})});i.value='';loadTodos();}
async function toggleTodo(id){await api('/api/todos/'+id+'/toggle',{method:'PUT',body:'{}'});loadTodos();}
async function loadNotes(){const{notes}=await api('/api/notes');document.getElementById('notes-list').innerHTML=notes.slice(0,5).map(n=>`<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)"><div style="font-weight:600;font-size:14px">${n.title}</div><div style="font-size:13px;color:#64748b">${(n.content||'').slice(0,80)}</div></div>`).join('');}
async function addNote(){const t=document.getElementById('note-title').value.trim(),c=document.getElementById('note-content').value.trim();if(!t)return;await api('/api/notes',{method:'POST',body:JSON.stringify({title:t,content:c})});document.getElementById('note-title').value='';document.getElementById('note-content').value='';loadNotes();}
async function askArivu(){const q=document.getElementById('ask-input').value.trim();if(!q)return;document.getElementById('ask-result').textContent='Thinking...';const{answer,error}=await api('/api/ask',{method:'POST',body:JSON.stringify({question:q})});document.getElementById('ask-result').textContent=answer||error||'No response';}
loadStatus();loadTodos();loadNotes();setInterval(loadStatus,30000);
</script></body></html>`));

app.listen(PORT, '0.0.0.0', () => console.log(`ArivuWatch running on port ${PORT}`));