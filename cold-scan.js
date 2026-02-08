#!/usr/bin/env node
// Cold-scan 50 popular small/medium business websites to generate outreach reports
const http = require('http');
const fs = require('fs');

const TARGETS = [
  // Local businesses, restaurants, small e-commerce — lawsuit targets
  'joesbarbershop.com', 'localplumber.com', 'townpizza.com',
  // Popular sites that likely have issues
  'craigslist.org', 'reddit.com', 'twitter.com', 'pinterest.com',
  'tumblr.com', 'wordpress.org', 'blogger.com', 'medium.com',
  'etsy.com', 'shopify.com', 'squarespace.com', 'wix.com',
  'godaddy.com', 'namecheap.com', 'bluehost.com',
  // E-commerce (high lawsuit risk)
  'zappos.com', 'overstock.com', 'wayfair.com', 'chewy.com',
  'bestbuy.com', 'target.com', 'walmart.com', 'costco.com',
  'homedepot.com', 'lowes.com', 'macys.com', 'nordstrom.com',
  // Food/restaurant chains (high lawsuit risk)  
  'dominos.com', 'pizzahut.com', 'subway.com', 'chipotle.com',
  'mcdonalds.com', 'wendys.com', 'burgerking.com', 'dunkindonuts.com',
  // Healthcare (very high lawsuit risk)
  'zocdoc.com', 'healthgrades.com', 'webmd.com',
  // Real estate
  'zillow.com', 'redfin.com', 'realtor.com', 'trulia.com',
  // Travel
  'booking.com', 'expedia.com', 'tripadvisor.com', 'airbnb.com',
  // Education
  'coursera.org', 'udemy.com', 'khanacademy.org',
  // Finance
  'mint.com', 'creditkarma.com'
];

async function scanUrl(url) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ url: 'https://' + url });
    const req = http.request({
      hostname: 'localhost', port: 3003, path: '/api/scan',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log(`Cold-scanning ${TARGETS.length} websites...\n`);
  const results = [];
  
  for (const url of TARGETS) {
    process.stdout.write(`Scanning ${url}... `);
    try {
      const data = await scanUrl(url);
      const r = {
        url,
        score: data.score,
        issues: data.issues ? data.issues.length : 0,
        critical: data.summary ? data.summary.critical : 0,
        complianceLevel: data.complianceLevel,
        topIssues: (data.issues || []).slice(0, 3).map(i => i.name)
      };
      results.push(r);
      console.log(`Score: ${r.score} | Issues: ${r.issues} | Critical: ${r.critical}`);
    } catch(e) {
      console.log(`FAILED: ${e.message}`);
      results.push({ url, error: e.message });
    }
    // Small delay to be polite
    await new Promise(r => setTimeout(r, 1000));
  }

  // Sort by worst scores
  const scored = results.filter(r => r.score !== undefined).sort((a, b) => a.score - b.score);
  
  console.log('\n\n========== COLD SCAN RESULTS ==========\n');
  console.log('WORST SCORES (best outreach targets):');
  scored.slice(0, 20).forEach((r, i) => {
    console.log(`${i+1}. ${r.url} — Score: ${r.score}/100, ${r.issues} issues (${r.critical} critical)`);
    if (r.topIssues) console.log(`   Top issues: ${r.topIssues.join(', ')}`);
  });

  // Save full results
  fs.writeFileSync('data/cold-scan-results.json', JSON.stringify({ timestamp: new Date().toISOString(), results: scored }, null, 2));
  console.log('\nFull results saved to data/cold-scan-results.json');
  
  // Generate outreach report
  const outreachTargets = scored.filter(r => r.score < 70 && r.critical > 0);
  console.log(`\n${outreachTargets.length} sites with score < 70 and critical issues — prime outreach targets.`);
}

main().catch(console.error);
