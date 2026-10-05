const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('./voice');
const { createRealtimeClientSecret } = require('../services/openaiMediaService');
const handleSession = router.stack.find(layer => layer.route?.path === '/session').route.stack[0].handle;

test('session route rejects invalid speed and instructions before contacting OpenAI', async () => {
    for (const body of [{ speed: 'slow' }, { speed: 0.1 }, { speed: 2 }, { speed: null }, { instructions: {} }]) {
        const res = {
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.payload = payload; }
        };
        await handleSession({ body }, res);
        assert.equal(res.statusCode, 400);
        assert.ok(res.payload.error);
    }
});

test('child voice settings reach OpenAI and other sessions keep normal speed', async (t) => {
    const requests = [];
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-placeholder';
    t.after(() => {
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
    });
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return { ok: true, text: async () => JSON.stringify({ value: 'test-client-secret' }) };
    });
    const res = { json(payload) { this.payload = payload; } };
    await handleSession({ body: { instructions: 'Child-friendly Nursery narration.', speed: 0.85 } }, res);
    assert.equal(res.payload.value, 'test-client-secret');
    assert.equal(requests[0].session.audio.output.speed, 0.85);
    assert.equal(requests[0].session.instructions, 'Child-friendly Nursery narration.');
    await createRealtimeClientSecret();
    assert.equal(requests[1].session.audio.output.speed, 1);
});
