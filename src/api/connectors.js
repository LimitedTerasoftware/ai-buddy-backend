const express = require('express');
const connectorService = require('../connectors/connectorService');

const router = express.Router();

// Get connector session status
router.get('/status', async (req, res) => {
    try {
        const authToken = req.headers.authorization;
        const status = await connectorService.getSessionStatus(authToken);
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List OneDrive files
router.get('/onedrive/files', async (req, res) => {
    try {
        const authToken = req.headers.authorization;
        const limit = req.query.limit || 10;
        const files = await connectorService.listOneDriveFiles(authToken, limit);
        res.json({ files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List Outlook emails
router.get('/outlook/emails', async (req, res) => {
    try {
        const authToken = req.headers.authorization;
        const limit = req.query.limit || 10;
        const emails = await connectorService.listOutlookEmails(authToken, limit);
        res.json({ emails });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
