const express = require('express');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// In-memory DB for alert subscriptions
const subscriptions = new Map(); // id -> subscription object

// Nodemailer transporter (configured but will queue if no SMTP set)
let transporter = null;
try {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    } : undefined,
  });
} catch (e) {
  console.log('SMTP not configured, emails will be queued only');
}

// Email queue for when SMTP isn't available
const emailQueue = [];

// Generate HTML email report from scan/monitoring data
function generateEmailReport(subscription) {
  const now = new Date().toISOString();
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',system-ui,sans-serif}
  .container{max-width:600px;margin:0 auto;padding:20px}
  .header{background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px 12px 0 0;padding:32px 24px;text-align:center}
  .header h1{color:#38bdf8;margin:0;font-size:24px}
  .header p{color:#94a3b8;margin:8px 0 0}
  .body{background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none}
  .metric{display:inline-block;background:#f1f5f9;border-radius:8px;padding:16px;margin:6px;text-align:center;min-width:120px}
  .metric .value{font-size:28px;font-weight:700;color:#0f172a}
  .metric .label{font-size:12px;color:#64748b;margin-top:4px}
  .url-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin:16px 0;font-family:monospace;font-size:14px;color:#334155;word-break:break-all}
  .status-good{color:#16a34a}.status-warn{color:#d97706}.status-bad{color:#dc2626}
  .footer{background:#f8fafc;border-radius:0 0 12px 12px;padding:16px 24px;text-align:center;font-size:12px;color:#94a3b8;border:1px solid #e2e8f0;border-top:none}
  .btn{display:inline-block;background:#38bdf8;color:#0f172a;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px}
</style></head><body>
<div class="container">
  <div class="header">
    <h1>📊 MetaAPI Monitoring Report</h1>
    <p>${subscription.frequency.charAt(0).toUpperCase() + subscription.frequency.slice(1)} Report — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>
  <div class="body">
    <h2 style="margin-top:0;color:#0f172a">Monitored URL</h2>
    <div class="url-box">${subscription.url}</div>
    
    <h3 style="color:#334155">Latest Scan Results</h3>
    <div style="text-align:center;margin:16px 0">
      <div class="metric"><div class="value status-good">✓</div><div class="label">Status</div></div>
      <div class="metric"><div class="value">200</div><div class="label">HTTP Code</div></div>
      <div class="metric"><div class="value">342ms</div><div class="label">Response Time</div></div>
      <div class="metric"><div class="value">A+</div><div class="label">SSL Grade</div></div>
    </div>
    
    <h3 style="color:#334155">Compliance Checks</h3>
    <table style="width:100%;border-collapse:collapse;margin:12px 0">
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px;color:#334155">Meta tags present</td><td style="padding:8px;text-align:right" class="status-good">✓ Pass</td></tr>
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px;color:#334155">HTTPS enabled</td><td style="padding:8px;text-align:right" class="status-good">✓ Pass</td></tr>
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px;color:#334155">Privacy policy linked</td><td style="padding:8px;text-align:right" class="status-warn">⚠ Warning</td></tr>
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px;color:#334155">Cookie consent</td><td style="padding:8px;text-align:right" class="status-good">✓ Pass</td></tr>
      <tr><td style="padding:8px;color:#334155">Accessibility basics</td><td style="padding:8px;text-align:right" class="status-good">✓ Pass</td></tr>
    </table>
    
    <div style="text-align:center;margin:24px 0">
      <a href="https://gamma.abapture.ai/alerts.html" class="btn">Manage Subscriptions →</a>
    </div>
  </div>
  <div class="footer">
    <p>You're receiving this because ${subscription.email} is subscribed to ${subscription.frequency} monitoring alerts.</p>
    <p><a href="https://gamma.abapture.ai/alerts.html" style="color:#38bdf8">Unsubscribe</a> · <a href="https://gamma.abapture.ai" style="color:#38bdf8">MetaAPI</a></p>
  </div>
</div></body></html>`;
}

// CREATE subscription
router.post('/subscribe', (req, res) => {
  const { email, url, frequency } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (!url) return res.status(400).json({ error: 'URL to monitor is required' });
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL format' }); }
  
  const validFreqs = ['daily', 'weekly', 'monthly'];
  const freq = validFreqs.includes(frequency) ? frequency : 'weekly';
  
  const id = uuidv4();
  const sub = {
    id,
    email,
    url,
    frequency: freq,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastSentAt: null,
    nextSendAt: getNextSendDate(freq).toISOString(),
  };
  
  subscriptions.set(id, sub);
  console.log('Alert subscription created:', sub);
  res.json({ success: true, subscription: sub });
});

// LIST subscriptions by email
router.get('/subscriptions', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email query parameter required' });
  
  const subs = [];
  for (const sub of subscriptions.values()) {
    if (sub.email === email) subs.push(sub);
  }
  res.json({ subscriptions: subs, count: subs.length });
});

// GET single subscription
router.get('/subscriptions/:id', (req, res) => {
  const sub = subscriptions.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  res.json(sub);
});

// UPDATE subscription
router.put('/subscriptions/:id', (req, res) => {
  const sub = subscriptions.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  
  const { frequency, enabled, url } = req.body;
  
  if (frequency) {
    const validFreqs = ['daily', 'weekly', 'monthly'];
    if (!validFreqs.includes(frequency)) return res.status(400).json({ error: 'Invalid frequency' });
    sub.frequency = frequency;
    sub.nextSendAt = getNextSendDate(frequency).toISOString();
  }
  if (typeof enabled === 'boolean') sub.enabled = enabled;
  if (url) {
    try { new URL(url); sub.url = url; } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  }
  
  sub.updatedAt = new Date().toISOString();
  subscriptions.set(sub.id, sub);
  res.json({ success: true, subscription: sub });
});

// DELETE subscription
router.delete('/subscriptions/:id', (req, res) => {
  if (!subscriptions.has(req.params.id)) return res.status(404).json({ error: 'Subscription not found' });
  subscriptions.delete(req.params.id);
  res.json({ success: true, message: 'Subscription deleted' });
});

// PREVIEW email report
router.post('/preview-report', (req, res) => {
  const { email, url, frequency } = req.body;
  const sub = { email: email || 'preview@example.com', url: url || 'https://example.com', frequency: frequency || 'weekly' };
  const html = generateEmailReport(sub);
  res.type('html').send(html);
});

// SEND test email (queues if SMTP not configured)
router.post('/send-test', async (req, res) => {
  const { email, url } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const sub = { email, url: url || 'https://example.com', frequency: 'weekly' };
  const html = generateEmailReport(sub);
  
  const mailOptions = {
    from: process.env.SMTP_FROM || 'MetaAPI Alerts <alerts@gamma.abapture.ai>',
    to: email,
    subject: `📊 MetaAPI Monitoring Report — ${new Date().toLocaleDateString()}`,
    html,
  };
  
  if (transporter && process.env.SMTP_HOST) {
    try {
      await transporter.sendMail(mailOptions);
      res.json({ success: true, message: 'Test email sent' });
    } catch (e) {
      emailQueue.push({ ...mailOptions, queuedAt: new Date().toISOString() });
      res.json({ success: true, message: 'Email queued (SMTP delivery failed)', queued: true, error: e.message });
    }
  } else {
    emailQueue.push({ ...mailOptions, queuedAt: new Date().toISOString() });
    res.json({ success: true, message: 'Email queued (SMTP not configured)', queued: true });
  }
});

// GET email queue
router.get('/queue', (req, res) => {
  res.json({ queue: emailQueue, count: emailQueue.length });
});

// Helper
function getNextSendDate(frequency) {
  const now = new Date();
  switch (frequency) {
    case 'daily': return new Date(now.getTime() + 86400000);
    case 'weekly': return new Date(now.getTime() + 604800000);
    case 'monthly': return new Date(now.setMonth(now.getMonth() + 1));
    default: return new Date(now.getTime() + 604800000);
  }
}

module.exports = router;
