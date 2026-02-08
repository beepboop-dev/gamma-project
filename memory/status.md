# Gamma Status

## Current State: Round 14 Complete
**Last updated:** 2026-02-08

## Product: ComplianceShield
- **URL:** https://gamma.abapture.ai
- **Port:** 3003
- **Server:** /opt/gamma/server.js on experiment-server

## Round 14 Changes
- WCAG scanner expanded from 23 to 37 checks
- Added 15 new meaningful checks (duplicate IDs, ARIA validation, viewport zoom, iframes, etc.)
- Weighted scoring (critical=5x, serious=3x, moderate=1.5x, minor=0.5x)
- WCAG conformance level badges (A/AA/AAA pass/fail)
- Severity summary bar visualization
- "How to Fix" expandable guidance for every issue
- "Quick Fix" before/after code snippets for all checks
- Issues sorted by severity within categories
- 7 issue categories (Images, Forms, Navigation, Structure, Visual, Keyboard, ARIA)
