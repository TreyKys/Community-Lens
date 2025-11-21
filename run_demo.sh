#!/bin/bash

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   Community Lens: End-to-End Demo       ${NC}"
echo -e "${BLUE}=========================================${NC}"

# 1. Check/Start Server
echo -e "\n${YELLOW}[1/3] Checking Verification Engine (Server)...${NC}"
if pgrep -f "node server/index.js" > /dev/null; then
    echo -e "${GREEN}✅ Server is already running.${NC}"
else
    echo -e "Starting server..."
    node server/index.js > server.log 2>&1 &
    SERVER_PID=$!
    sleep 2
    echo -e "${GREEN}✅ Server started (PID $SERVER_PID).${NC}"
fi

# 2. Publish Truth Patch
echo -e "\n${YELLOW}[2/3] Analyzing Claim & Minting Truth Patch...${NC}"
echo -e "Claim: 'The Lagos-Abuja Underwater Tunnel was completed in 2024.'"
node demo_publish.js

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Publishing failed. Check server logs.${NC}"
    exit 1
fi

# 3. Run Agent Guard
echo -e "\n${YELLOW}[3/3] Simulating AI Agent Guard...${NC}"
echo -e "User Question: 'Is there a Lagos-Abuja Underwater Tunnel?'"
sleep 1
node demo_guard.js "Is there a Lagos-Abuja Underwater Tunnel?"

echo -e "\n${BLUE}=========================================${NC}"
echo -e "${GREEN}   Demo Complete! ${NC}"
echo -e "${BLUE}=========================================${NC}"
