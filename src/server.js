require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const documentRoutes = require('./api/documents');
const brainRoutes = require('./api/brain');
const connectorRoutes = require('./api/connectors');
const databaseRoutes = require('./api/databases');
const voiceRoutes = require('./api/voice');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/documents', documentRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/connectors', connectorRoutes);
app.use('/api/databases', databaseRoutes);
app.use('/api/voice', voiceRoutes);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Company Brain API is running' });
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception caught:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(port, async () => {
    console.log(`Server is running on port ${port}`);
    await db.initDb();
});
