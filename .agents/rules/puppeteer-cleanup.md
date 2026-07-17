---
name: puppeteer-cleanup
description: Automatically clean up hanging Chrome processes after failed Puppeteer tests.
---
# Puppeteer Cleanup Rule

**Trigger**: Whenever a background task running a Puppeteer script (`puppeteer`, `chrome`, etc.) crashes, times out, or fails to exit cleanly.

**Action**: 
1. The agent MUST proactively check for hanging Chrome processes by running `ps aux | grep chrome` or directly clean them up using `pkill -f chrome`.
2. Do not wait for the user to complain about memory leaks or lag. Automatically clean up orphaned headless instances to prevent memory exhaustion.
