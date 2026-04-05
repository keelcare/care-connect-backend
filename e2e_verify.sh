#!/bin/bash
API_URL="http://localhost:4000"
EMAIL="parent@example.com"
PASSWORD="password"

echo "1. Login..."
LOGIN_OUT=$(curl -s -i -X POST "$API_URL/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\", \"password\":\"$PASSWORD\"}")
ACCESS_TOKEN=$(echo "$LOGIN_OUT" | grep -o 'access_token=[^;]*' | head -1)
REFRESH_TOKEN=$(echo "$LOGIN_OUT" | grep -o 'refresh_token=[^;]*' | head -1)
echo "Tokens acquired."

echo -e "\n2. Test with Valid Access Token..."
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" -X GET "$API_URL/requests/parent/me" -H "Cookie: $ACCESS_TOKEN; $REFRESH_TOKEN"

echo -e "\n3. Test Transparent Refresh (Invalid Access Token + Valid Refresh Token)..."
curl -s -i -X GET "$API_URL/requests/parent/me" -H "Cookie: access_token=expired_token; $REFRESH_TOKEN" | head -n 20

