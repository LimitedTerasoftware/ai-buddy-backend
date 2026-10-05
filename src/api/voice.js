const express = require('express');
const { createRealtimeClientSecret } = require('../services/openaiMediaService');

const router = express.Router();

router.post('/session', async (req, res) => {
    try {
        const { instructions, speed } = req.body || {};
        if (instructions !== undefined && typeof instructions !== 'string') {
            return res.status(400).json({ error: 'Instructions must be text.' });
        }
        if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 1.5)) {
            return res.status(400).json({ error: 'Voice speed must be between 0.25 and 1.5.' });
        }
        const session = await createRealtimeClientSecret({ instructions, speed });
        res.json(session);
    } catch (err) {
        console.error('Realtime session error:', err);
        res.status(500).json({ error: err.message || 'Failed to create realtime session' });
    }
});

module.exports = router;
