const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3003;

// Stripe webhook needs raw body
app.post('/webhook', express.raw({ type: 'application/json' }), require('./routes/webhook'));

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting store (in-memory, resets on restart)
const rateLimits = new Map();
const apiKeys = new Map(); // apiKey -> { tier, email, stripeCustomerId }

// Seed a demo key
apiKeys.set('demo-key-12345', { tier: 'free', email: 'demo@example.com' });

function getRateLimit(tier) {
  switch (tier) {
    case 'pro': return 10000;
    case 'enterprise': return Infinity;
    default: return 100;
  }
}

function rateLimitMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Pass x-api-key header or api_key query param.' });
  }

  const keyData = apiKeys.get(apiKey);
  if (!keyData) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const limKey = `${apiKey}:${today}`;
  const count = rateLimits.get(limKey) || 0;
  const limit = getRateLimit(keyData.tier);

  if (count >= limit) {
    return res.status(429).json({ error: 'Rate limit exceeded. Upgrade your plan at /pricing.' });
  }

  rateLimits.set(limKey, count + 1);
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count - 1)));
  req.apiKeyData = keyData;
  next();
}

// --- API Routes ---
const apiRouter = express.Router();
apiRouter.use(rateLimitMiddleware);

// 1. Email validation
apiRouter.get('/validate/email', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param required' });
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid = re.test(email);
  const [, domain] = email.split('@');
  res.json({ email, valid, domain: domain || null, suggestion: null });
});

// 2. URL metadata
apiRouter.get('/meta/url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'MetaAPI/1.0' } });
    const html = await resp.text();
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    res.json({
      url,
      title: $('title').text() || null,
      description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || null,
      image: $('meta[property="og:image"]').attr('content') || null,
      favicon: $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || null,
    });
  } catch (e) {
    res.status(422).json({ error: 'Could not fetch URL', detail: e.message });
  }
});

// 3. QR code generation
apiRouter.get('/generate/qr', async (req, res) => {
  const { text, format } = req.query;
  if (!text) return res.status(400).json({ error: 'text query param required' });
  const QRCode = require('qrcode');
  if (format === 'svg') {
    const svg = await QRCode.toString(text, { type: 'svg' });
    res.type('image/svg+xml').send(svg);
  } else {
    const dataUrl = await QRCode.toDataURL(text);
    res.json({ text, qr_data_url: dataUrl });
  }
});

// 4. Hash
apiRouter.get('/generate/hash', (req, res) => {
  const { text, algorithm } = req.query;
  if (!text) return res.status(400).json({ error: 'text query param required' });
  const crypto = require('crypto');
  const algo = algorithm || 'sha256';
  try {
    const hash = crypto.createHash(algo).update(text).digest('hex');
    res.json({ text, algorithm: algo, hash });
  } catch (e) {
    res.status(400).json({ error: `Unsupported algorithm: ${algo}` });
  }
});

// 5. UUID generation
apiRouter.get('/generate/uuid', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 1, 100);
  const uuids = Array.from({ length: count }, () => uuidv4());
  res.json({ count, uuids });
});

// 6. Text analysis
apiRouter.post('/analyze/text', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text field required in JSON body' });
  const words = text.trim().split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());
  const chars = text.length;
  res.json({
    characters: chars,
    words: words.length,
    sentences: sentences.length,
    avg_word_length: words.length ? +(words.reduce((a, w) => a + w.length, 0) / words.length).toFixed(1) : 0,
    reading_time_seconds: Math.ceil(words.length / 4.2),
  });
});

// 7. IP info (returns requester's IP)
apiRouter.get('/lookup/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  res.json({ ip });
});

// 8. Timestamp conversion
apiRouter.get('/convert/timestamp', (req, res) => {
  const { ts, date } = req.query;
  if (ts) {
    const d = new Date(Number(ts) * 1000);
    return res.json({ unix: Number(ts), iso: d.toISOString(), utc: d.toUTCString() });
  }
  if (date) {
    const d = new Date(date);
    if (isNaN(d)) return res.status(400).json({ error: 'Invalid date string' });
    return res.json({ unix: Math.floor(d.getTime() / 1000), iso: d.toISOString(), utc: d.toUTCString() });
  }
  const now = new Date();
  res.json({ unix: Math.floor(now.getTime() / 1000), iso: now.toISOString(), utc: now.toUTCString() });
});

app.use('/v1', apiRouter);

// --- Stripe Checkout ---
const STRIPE_PK = process.env.STRIPE_PUBLISHABLE_KEY;

app.post('/create-checkout', express.json(), async (req, res) => {
  const { plan, email } = req.body;
  const prices = { pro: 900, enterprise: 4900 };
  const amount = prices[plan];
  if (!amount) return res.status(400).json({ error: 'Invalid plan. Choose pro or enterprise.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          recurring: { interval: 'month' },
          product_data: { name: `MetaAPI ${plan.charAt(0).toUpperCase() + plan.slice(1)}` },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      customer_email: email || undefined,
      success_url: `https://gamma.abapture.ai/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://gamma.abapture.ai/#pricing`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/success', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.redirect('/');
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // Generate API key for new subscriber
    const newKey = `ma_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    const plan = session.amount_total === 4900 ? 'enterprise' : 'pro';
    apiKeys.set(newKey, { tier: plan, email: session.customer_email, stripeCustomerId: session.customer });
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Success — MetaAPI</title>
    <style>body{font-family:system-ui;max-width:600px;margin:80px auto;text-align:center;color:#e2e8f0;background:#0f172a}
    .key{background:#1e293b;padding:16px;border-radius:8px;font-family:monospace;font-size:1.1em;color:#38bdf8;word-break:break-all;margin:20px 0}
    a{color:#38bdf8}</style></head><body>
    <h1>🎉 Welcome to MetaAPI ${plan.charAt(0).toUpperCase() + plan.slice(1)}!</h1>
    <p>Your API key:</p><div class="key">${newKey}</div>
    <p>Save this key — you won't see it again.</p>
    <p><a href="/#docs">Read the docs →</a></p></body></html>`);
  } catch (e) {
    res.redirect('/');
  }
});

// Key generation for free tier
app.post('/generate-key', express.json(), (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const newKey = `ma_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  apiKeys.set(newKey, { tier: 'free', email });
  res.json({ api_key: newKey, tier: 'free', daily_limit: 100 });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => console.log(`MetaAPI running on :${PORT}`));

module.exports = { app, apiKeys };
