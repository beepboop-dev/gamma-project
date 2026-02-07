const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const dns = require('dns');
const { URL } = require('url');
const QRCode = require('qrcode');
const Stripe = require('stripe');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3003;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_PK = process.env.STRIPE_PUBLISHABLE_KEY;

// In-memory API key store (would be DB in production)
const apiKeys = new Map();
const usage = new Map();

// Middleware
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting (simple in-memory)
const rateLimits = new Map();
function rateLimit(key, limit = 100) {
  const now = Date.now();
  const day = Math.floor(now / 86400000);
  const k = `${key}:${day}`;
  const count = rateLimits.get(k) || 0;
  if (count >= limit) return false;
  rateLimits.set(k, count + 1);
  return true;
}

// Auth middleware
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) {
    // Allow demo usage with rate limiting by IP
    req.tier = 'free';
    req.userId = req.ip;
    if (!rateLimit(req.ip, 100)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Get an API key for higher limits.' });
    }
    return next();
  }
  const user = apiKeys.get(key);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });
  req.tier = user.tier;
  req.userId = user.id;
  const limit = user.tier === 'enterprise' ? Infinity : user.tier === 'pro' ? 10000 : 100;
  if (!rateLimit(key, limit)) {
    return res.status(429).json({ error: 'Daily rate limit exceeded. Upgrade your plan.' });
  }
  // Track usage
  usage.set(key, (usage.get(key) || 0) + 1);
  next();
}

// ============ API ENDPOINTS ============

// 1. Email Validation
app.get('/api/v1/email/validate', authenticate, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email parameter required' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const syntaxValid = emailRegex.test(email);
    const domain = email.split('@')[1];

    const disposableDomains = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la', 'dispostable.com', '10minutemail.com'];
    const isDisposable = disposableDomains.includes(domain?.toLowerCase());

    let mxRecords = [];
    let hasMx = false;
    if (domain && syntaxValid) {
      try {
        mxRecords = await new Promise((resolve, reject) => {
          dns.resolveMx(domain, (err, records) => err ? resolve([]) : resolve(records));
        });
        hasMx = mxRecords.length > 0;
      } catch (e) { /* no MX */ }
    }

    res.json({
      email,
      valid: syntaxValid && hasMx && !isDisposable,
      syntax_valid: syntaxValid,
      mx_found: hasMx,
      mx_records: mxRecords.slice(0, 5),
      is_disposable: isDisposable,
      domain,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// 2. URL Metadata
app.get('/api/v1/url/metadata', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parameter required' });

    const response = await fetch(url, {
      headers: { 'User-Agent': 'MetaAPI/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const html = await response.text();

    const getTag = (name, attr = 'content') => {
      const match = html.match(new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*${attr}=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]*${attr}=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'));
      return match ? match[1] : null;
    };
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

    res.json({
      url,
      status: response.status,
      title: titleMatch?.[1]?.trim() || null,
      description: getTag('description') || getTag('og:description'),
      og_title: getTag('og:title'),
      og_description: getTag('og:description'),
      og_image: getTag('og:image'),
      og_type: getTag('og:type'),
      og_site_name: getTag('og:site_name'),
      twitter_card: getTag('twitter:card'),
      twitter_title: getTag('twitter:title'),
      twitter_description: getTag('twitter:description'),
      twitter_image: getTag('twitter:image'),
      favicon: new URL('/favicon.ico', url).href,
    });
  } catch (err) {
    res.status(422).json({ error: 'Could not fetch URL', details: err.message });
  }
});

// 3. QR Code Generation
app.get('/api/v1/qr/generate', authenticate, async (req, res) => {
  const { text, format = 'png', size = 300 } = req.query;
  if (!text) return res.status(400).json({ error: 'Text parameter required' });

  try {
    if (format === 'svg') {
      const svg = await QRCode.toString(text, { type: 'svg', width: parseInt(size) });
      res.type('image/svg+xml').send(svg);
    } else if (format === 'base64') {
      const dataUrl = await QRCode.toDataURL(text, { width: parseInt(size) });
      res.json({ text, format: 'base64', data: dataUrl });
    } else {
      const buffer = await QRCode.toBuffer(text, { width: parseInt(size) });
      res.type('image/png').send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// 4. Hash Generation
app.post('/api/v1/hash', authenticate, (req, res) => {
  const { text, algorithm = 'sha256' } = req.body;
  if (!text) return res.status(400).json({ error: 'Text field required in body' });

  const algos = ['md5', 'sha1', 'sha256', 'sha512'];
  if (algorithm === 'all') {
    const hashes = {};
    for (const algo of algos) {
      hashes[algo] = crypto.createHash(algo).update(text).digest('hex');
    }
    return res.json({ text_length: text.length, hashes });
  }

  if (!algos.includes(algorithm)) {
    return res.status(400).json({ error: `Unsupported algorithm. Use: ${algos.join(', ')} or "all"` });
  }
  const hash = crypto.createHash(algorithm).update(text).digest('hex');
  res.json({ algorithm, hash, text_length: text.length });
});

// 5. Text Analysis
app.post('/api/v1/text/analyze', authenticate, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text field required in body' });

  const words = text.trim().split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

  // Simple sentiment
  const positiveWords = ['good', 'great', 'excellent', 'amazing', 'wonderful', 'fantastic', 'love', 'happy', 'best', 'awesome', 'perfect', 'beautiful'];
  const negativeWords = ['bad', 'terrible', 'awful', 'horrible', 'hate', 'worst', 'ugly', 'poor', 'sad', 'angry', 'disgusting', 'disappointing'];
  const lower = text.toLowerCase();
  const posCount = positiveWords.filter(w => lower.includes(w)).length;
  const negCount = negativeWords.filter(w => lower.includes(w)).length;
  const sentiment = posCount > negCount ? 'positive' : negCount > posCount ? 'negative' : 'neutral';

  // Reading time (avg 200 wpm)
  const readingTimeMin = Math.ceil(words.length / 200);

  // Word frequency
  const freq = {};
  words.forEach(w => {
    const lw = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (lw.length > 2) freq[lw] = (freq[lw] || 0) + 1;
  });
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  res.json({
    characters: text.length,
    characters_no_spaces: text.replace(/\s/g, '').length,
    words: words.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    reading_time_minutes: readingTimeMin,
    sentiment,
    top_words: Object.fromEntries(topWords),
  });
});

// 6. UUID Generation
app.get('/api/v1/uuid', authenticate, (req, res) => {
  const { count = 1, version = 'v4' } = req.query;
  const n = Math.min(parseInt(count) || 1, 100);
  const uuids = Array.from({ length: n }, () => crypto.randomUUID());
  res.json({ count: n, uuids });
});

// 7. IP Info (returns requester's IP)
app.get('/api/v1/ip', authenticate, (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  res.json({ ip });
});

// 8. JSON Formatter / Validator
app.post('/api/v1/json/validate', authenticate, (req, res) => {
  const { json } = req.body;
  if (!json) return res.status(400).json({ error: 'JSON string required in body' });
  try {
    const parsed = JSON.parse(typeof json === 'string' ? json : JSON.stringify(json));
    res.json({ valid: true, formatted: JSON.stringify(parsed, null, 2), keys: Object.keys(parsed).length });
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});

// ============ STRIPE BILLING ============

app.post('/api/v1/billing/checkout', express.json(), async (req, res) => {
  const { plan, email } = req.body;
  if (!plan || !email) return res.status(400).json({ error: 'Plan and email required' });

  const prices = { pro: 900, enterprise: 4900 }; // cents
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan. Use: pro, enterprise' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `MetaAPI ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan` },
          unit_amount: prices[plan],
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: `${req.protocol}://${req.get('host')}/?success=true`,
      cancel_url: `${req.protocol}://${req.get('host')}/?canceled=true`,
    });
    res.json({ checkout_url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Checkout creation failed', details: err.message });
  }
});

// Generate API key (demo)
app.post('/api/v1/keys/generate', (req, res) => {
  const { email, tier = 'free' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const key = `meta_${tier}_${crypto.randomBytes(24).toString('hex')}`;
  apiKeys.set(key, { id: email, tier, created: new Date().toISOString() });
  res.json({ api_key: key, tier, message: 'Store this key securely. It cannot be retrieved again.' });
});

// Health
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', endpoints: 8, uptime: process.uptime() });
});

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MetaAPI running on port ${PORT}`);
});
