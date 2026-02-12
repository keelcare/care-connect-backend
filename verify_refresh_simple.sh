#!/bin/bash

# Configuration
API_URL="http://localhost:4000"
EMAIL="parent@example.com"
PASSWORD="password"

echo "1. Logging in..."
LOGIN_OUT=$(curl -s -i -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\", \"password\":\"$PASSWORD\"}")

# Extract cookies
ACCESS_TOKEN=$(echo "$LOGIN_OUT" | grep -o 'access_token=[^;]*' | head -1)
REFRESH_TOKEN=$(echo "$LOGIN_OUT" | grep -o 'refresh_token=[^;]*' | head -1)

if [ -z "$ACCESS_TOKEN" ] || [ -z "$REFRESH_TOKEN" ]; then
  echo "Login failed. Could not get tokens."
  echo "$LOGIN_OUT"
  exit 1
fi

echo "Access Token acquired."
echo "Refresh Token acquired."

echo -e "\n2. Accessing protected endpoint with VALID access token..."
VALID_REQ=$(curl -s -i -X GET "$API_URL/requests/parent/me" \
  -H "Cookie: $ACCESS_TOKEN; $REFRESH_TOKEN")

if echo "$VALID_REQ" | grep -q "HTTP/1.1 200"; then
  echo "SUCCESS: Protected endpoint accessible with valid token."
else
  echo "FAILED: Protected endpoint not accessible with valid token."
  echo "$VALID_REQ" | head -n 25
fi

echo -e "\n3. Accessing protected endpoint with INVALID access token but VALID refresh token..."
INVALID_ACCESS_TOKEN="access_token=invalid_token_here"
REFRESH_REQ=$(curl -s -i -X GET "$API_URL/requests/parent/me" \
  -H "Cookie: $REFRESH_TOKEN")

if echo "$REFRESH_REQ" | grep -q "HTTP/1.1 200"; then
  echo "SUCCESS: Transparent refresh worked! Endpoint returned 200."
  
  # Check if new cookies were set
  NEW_ACCESS=$(echo "$REFRESH_REQ" | grep -o 'access_token=[^;]*' | head -1)
  if [ -n "$NEW_ACCESS" ] && [ "$NEW_ACCESS" != "$ACCESS_TOKEN" ] && [ "$NEW_ACCESS" != "$INVALID_ACCESS_TOKEN" ]; then
    echo "SUCCESS: New access token was issued via Set-Cookie."
  else
    echo "FAILED: New access token NOT found in response headers or is same as old."
    echo "$REFRESH_REQ" | grep "Set-Cookie"
  fi
else
  echo "FAILED: Transparent refresh failed. Endpoint returned non-200."
  echo "$REFRESH_REQ" | head -n 30
  # Check for error body
  echo -e "\nError Body:"
  echo "$REFRESH_REQ" | tail -n 1
fi

