# Quick Test Plan

Follow these steps to verify the fix immediately.

## 1. Start the Server
Ensure the backend service is running.

```bash
node server/index.js > server.log 2>&1 &
```

## 2. Verify the API
Call the analyze endpoint. It should return a JSON result with a `truthScore` (likely low for the test claim due to the "Lagos-Abuja" hardcoded fallback).

```bash
curl -s -X POST http://localhost:4000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"claim":"The Lagos-Abuja Underwater Tunnel opened in 2024."}' | grep truthScore
```

## 3. Run the End-to-End Demo
This script calls the API, mints a Truth Patch to the mock DKG, and saves the Asset ID.

```bash
node demo_publish.js
```
**Expected Output:**
*   `Truth Score: 15%` (or similar low score)
*   `✅ Truth Patch Minted! Asset ID: did:dkg:...`

## 4. Run the Agent Guard
This script simulates an AI agent checking the firewall.

```bash
node demo_guard.js "Is there a Lagos-Abuja Underwater Tunnel?"
```
**Expected Output:**
*   `⛔ BLOCKED: Evidence asset ...`
*   `Reason: Truth Score 15% (Below Threshold)`

## 5. Check Server Logs
To confirm internal behavior (fallback vs API usage):

```bash
tail -n 20 server.log
```
