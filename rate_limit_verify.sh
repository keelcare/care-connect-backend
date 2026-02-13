#!/bin/bash
API_URL="http://localhost:4000"

echo "===================================================="
echo "    VERIFYING OPTIMIZED RATE LIMITING    "
echo "===================================================="

# 1. Test Global Limit (Should allow > 10 requests easily)
echo -e "\n[1] Testing Global Limit (Target: 30 requests)..."
for i in {1..30}
do
   STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$API_URL/requests/parent/me")
   if [ "$STATUS" != "401" ] && [ "$STATUS" != "200" ]; then
       echo "FAILED: Received $STATUS at request $i"
       exit 1
   fi
done
echo "SUCCESS: 30 requests handled without 429."

# 2. Test Strict Limit (Should trigger 429 after 10 requests)
echo -e "\n[2] Testing Strict Limit on /auth/login (Target: Trigger 429)..."
for i in {1..15}
do
   STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com", "password":"wrong"}')
   
   if [ "$STATUS" == "429" ]; then
       echo "SUCCESS: Rate limit triggered at request $i."
       break
   fi
   
   if [ $i -eq 15 ]; then
       echo "FAILED: Strict rate limit was not triggered after 15 requests."
       exit 1
   fi
done

echo -e "\n===================================================="
echo "                VERIFICATION COMPLETE             "
echo "===================================================="
