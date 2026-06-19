const express = require('express');
const cors    = require('cors');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ── Load mock data ──────────────────────────────────────────────────────────
function loadData(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-data', file), 'utf8'));
}

// Live state — mutated by scenario triggers, reset reloads from disk
let state = {
  github:   loadData('github.json'),
  jira:     loadData('jira.json'),
  datadog:  loadData('datadog.json'),
  testrail: loadData('testrail.json'),
};
const scenarios = loadData('events.json').scenarios;

function resetState() {
  state = {
    github:   loadData('github.json'),
    jira:     loadData('jira.json'),
    datadog:  loadData('datadog.json'),
    testrail: loadData('testrail.json'),
  };
}

// ── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('[WS] client connected');
  // Send full state snapshot on connect
  ws.send(JSON.stringify({ type: 'snapshot', data: buildSnapshot() }));
  ws.on('close', () => console.log('[WS] client disconnected'));
});

function buildSnapshot() {
  return {
    coverage:          state.testrail.summary.coverage,
    total_tests:       state.testrail.summary.total,
    escaped_defects:   89 - state.testrail.summary.passing + state.testrail.summary.failing,
    stale_tests:       state.testrail.summary.stale,
    payment_error_rate: state.datadog.metrics.payment_error_rate.current,
    api_latency_p95:   state.datadog.metrics.api_latency_p95.current,
    active_sessions:   state.datadog.metrics.active_sessions.current,
    checkout_funnel:   state.datadog.metrics.checkout_funnel,
    p1_open:           state.jira.summary.p1_open,
    total_prs:         state.github.pulls.length,
    risky_prs:         state.github.pulls.filter(p => p.risk_score > 70 && !p.merged).length,
    alerts:            state.datadog.alerts,
    ci_status:         state.github.repo.ci_status,
  };
}

// ── GitHub routes ─────────────────────────────────────────────────────────────
app.get('/api/github/pulls', (req, res) => {
  res.json({ pulls: state.github.pulls, repo: state.github.repo });
});

app.get('/api/github/pulls/:id', (req, res) => {
  const pr = state.github.pulls.find(p => p.number === parseInt(req.params.id));
  if (!pr) return res.status(404).json({ error: 'PR not found' });
  res.json(pr);
});

// ── Jira routes ───────────────────────────────────────────────────────────────
app.get('/api/jira/issues', (req, res) => {
  const { priority, status, component } = req.query;
  let issues = state.jira.issues;
  if (priority)  issues = issues.filter(i => i.priority === priority);
  if (status)    issues = issues.filter(i => i.status   === status);
  if (component) issues = issues.filter(i => i.component === component);
  res.json({ issues, summary: state.jira.summary });
});

// ── Datadog routes ────────────────────────────────────────────────────────────
app.get('/api/datadog/metrics', (req, res) => {
  res.json(state.datadog);
});

app.get('/api/datadog/metrics/:metric', (req, res) => {
  const m = state.datadog.metrics[req.params.metric];
  if (!m) return res.status(404).json({ error: 'Metric not found' });
  res.json(m);
});

// ── TestRail routes ───────────────────────────────────────────────────────────
app.get('/api/testrail/summary', (req, res) => {
  res.json(state.testrail);
});

// ── Snapshot ──────────────────────────────────────────────────────────────────
app.get('/api/snapshot', (req, res) => {
  res.json(buildSnapshot());
});

// ── Scenario trigger ──────────────────────────────────────────────────────────
app.post('/api/trigger', (req, res) => {
  const { scenario } = req.body;

  if (scenario === 'reset') {
    resetState();
    broadcast({ type: 'snapshot', data: buildSnapshot() });
    broadcast(scenarios.reset.broadcast);
    return res.json({ ok: true, scenario: 'reset' });
  }

  const s = scenarios[scenario];
  if (!s) return res.status(404).json({ error: 'Unknown scenario' });

  // Apply dot-path changes to state
  for (const [dotPath, value] of Object.entries(s.changes)) {
    setNestedValue(state, dotPath, value);
  }

  // Broadcast the event + updated snapshot
  broadcast(s.broadcast);
  broadcast({ type: 'snapshot', data: buildSnapshot() });

  console.log(`[trigger] scenario="${scenario}"`);
  res.json({ ok: true, scenario, snapshot: buildSnapshot() });
});

// ── List available scenarios ───────────────────────────────────────────────────
app.get('/api/scenarios', (req, res) => {
  res.json(
    Object.entries(scenarios).map(([id, s]) => ({
      id,
      label: s.label,
      description: s.description,
    }))
  );
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), sources: ['github', 'jira', 'datadog', 'testrail'] });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setNestedValue(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = isNaN(parts[i]) ? parts[i] : parseInt(parts[i]);
    if (cur[key] === undefined) cur[key] = {};
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  cur[isNaN(last) ? last : parseInt(last)] = value;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🟢 Hielios mock backend running`);
  console.log(`   REST  → http://localhost:${PORT}/api`);
  console.log(`   WS    → ws://localhost:${PORT}`);
  console.log(`\n   Key endpoints:`);
  console.log(`   GET  /api/snapshot          — full dashboard state`);
  console.log(`   GET  /api/github/pulls      — PRs`);
  console.log(`   GET  /api/jira/issues       — issues`);
  console.log(`   GET  /api/datadog/metrics   — metrics`);
  console.log(`   GET  /api/testrail/summary  — test coverage`);
  console.log(`   POST /api/trigger           — fire a demo scenario`);
  console.log(`   GET  /api/scenarios         — list available scenarios\n`);
});
