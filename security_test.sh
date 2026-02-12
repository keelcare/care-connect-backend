#!/bin/bash
API_URL="http://localhost:4000"
EMAIL="parent@example.com"
PASSWORD="password"

echo "===================================================="
echo "    SECURITY AUDIT: AUTH PERSISTENCE MECHANISM    "
echo "===================================================="

# 1. Login to get initial tokens
echo -e "\n[1] Initial Login..."
LOGIN_OUT=$(curl -s -i -X POST "$API_URL/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\", \"password\":\"$PASSWORD\"}")
RAW_ACCESS_TOKEN=$(echo "$LOGIN_OUT" | grep -o 'access_token=[^;]*' | head -1 | cut -d'=' -f2)
RAW_REFRESH_TOKEN=$(echo "$LOGIN_OUT" | grep -o 'refresh_token=[^;]*' | head -1 | cut -d'=' -f2)

if [ -z "$RAW_ACCESS_TOKEN" ]; then
    echo "FAILED: Initial login failed."
    exit 1
fi
echo "SUCCESS: Logged in and tokens acquired."

# 2. Verify Cookie Security Attributes
echo -e "\n[2] Checking Cookie Security Attributes..."
if echo "$LOGIN_OUT" | grep -qi "HttpOnly"; then
    echo "SUCCESS: HttpOnly flag found in Set-Cookie."
else
    echo "FAILED: HttpOnly flag NOT found."
fi

# 3. Test Access Token Tampering
echo -e "\n[3] Testing Access Token Tampering..."
TAMPERED_AT="${RAW_ACCESS_TOKEN%?}z" # Change last character
TAMPERED_AT_OUT=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$API_URL/requests/parent/me" \
    -H "Cookie: access_token=$TAMPERED_AT; refresh_token=invalid_refresh")
if [ "$TAMPERED_AT_OUT" == "401" ]; then
    echo "SUCCESS: Tampered access token rejected (401)."
else
    echo "FAILED: Tampered access token returned $TAMPERED_AT_OUT."
fi

# 4. Test Refresh Token Tampering
echo -e "\n[4] Testing Refresh Token Tampering..."
TAMPERED_RT="${RAW_REFRESH_TOKEN%?}z" # Change last character
TAMPERED_RT_OUT=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$API_URL/requests/parent/me" \
    -H "Cookie: access_token=expired_token; refresh_token=$TAMPERED_RT")
if [ "$TAMPERED_RT_OUT" == "401" ]; then
    echo "SUCCESS: Tampered refresh token rejected (401)."
else
    echo "FAILED: Tampered refresh token returned $TAMPERED_RT_OUT."
fi

# 5. Test Refresh Token Association (Token swap)
# We'll just verify that a refresh token MUST be a valid JWT signed by our secret
echo -e "\n[5] Testing Refresh Token Signature Integrity..."
# Create a fake JWT-like string
FAKE_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InBhcmVudEBleGFtcGxlLmNvbSIsInN1YSI6IjEyMyIsImlhdCI6MTYyMDAwMDAwMH0.fake_signature"
FAKE_RT_OUT=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$API_URL/requests/parent/me" \
    -H "Cookie: access_token=expired_token; refresh_token=$FAKE_JWT")
if [ "$FAKE_RT_OUT" == "401" ]; then
    echo "SUCCESS: Fake JWT signature rejected."
else
    echo "FAILED: Fake JWT signature returned $FAKE_RT_OUT."
fi

# 6. Check for Data Leakage in protected endpoint
echo -e "\n[6] Checking for sensitive data leakage..."
LEAK_CHECK=$(curl -s -X GET "$API_URL/requests/parent/me" \
    -H "Cookie: access_token=$RAW_ACCESS_TOKEN; refresh_token=$RAW_REFRESH_TOKEN")
if echo "$LEAK_CHECK" | grep -qiE "password_hash|refresh_token_hash"; then
    echo "FAILED: Sensitive hashes found in response body!"
else
    echo "SUCCESS: No sensitive hashes found in response body."
fi

echo -e "\n===================================================="
echo "                SECURITY AUDIT COMPLETE             "
echo "===================================================="
