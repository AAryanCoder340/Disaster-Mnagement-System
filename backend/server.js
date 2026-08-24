require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./db');
const reportsRouter = require('./routes/reports');
const dashboardRouter = require('./routes/dashboard');
const usersRouter = require('./routes/users');
const hazardsRouter = require('./routes/hazards');
const incidentsRouter = require('./routes/incidents');
const officialRouter = require('./routes/official');
const sheltersRouter = require('./routes/shelters');
const sosRouter = require('./routes/sos');
const socialRouter = require('./routes/social');
const riskRouter = require('./routes/risk');
const historicalDataRouter = require('./routes/historical_data');
const { addClient } = require('./lib/sse');
const { startOfficialIngest } = require('./services/ingest');
const { startSocialIngest } = require('./services/socialIntelligence');

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const frontendRoot = path.join(__dirname, '..');
const uploadRoot = path.join(__dirname, 'uploads');

initDatabase();
try { fs.mkdirSync(uploadRoot, { recursive: true }); } catch (_) { /* noop */ }

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', service: 'CoastWatch API' });
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: connected\ndata: {"ok":true}\n\n');
  addClient(res);
});

app.use('/uploads', express.static(uploadRoot, { maxAge: '1y', immutable: true }));

app.use('/api/reports', reportsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/users', usersRouter);
app.use('/api/hazards', hazardsRouter);
app.use('/api/incidents', incidentsRouter);
app.use('/api/official', officialRouter);
app.use('/api/shelters', sheltersRouter);
app.use('/api/sos', sosRouter);
app.use('/api/social', socialRouter);
app.use('/api/risk', riskRouter);
app.use('/api/historical-data', historicalDataRouter);

app.use(express.static(frontendRoot));

app.get('/', (req, res) => {
  res.sendFile(path.join(frontendRoot, 'Index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'API endpoint not found' });
  }
  res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CoastWatch API running at http://localhost:${PORT}`);
  console.log(`Open the app at http://localhost:${PORT}/`);
  console.log(`Database: ${process.env.DATABASE_PATH || './data/coastwatch.db'}`);
  startOfficialIngest();
  startSocialIngest();
});
