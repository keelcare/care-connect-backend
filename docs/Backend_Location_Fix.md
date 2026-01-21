# Bug Report: Location Query Failure (500 Internal Server Error)

## 🚨 Critical Issue

The `/location/nannies/nearby` endpoint is crashing with a **500 Internal Server Error** when called by the frontend.

**Error Log:**

```
Invalid `prisma.$queryRawUnsafe()` invocation:
Raw query failed. Code: `22003`. Message: `ERROR: input is out of range`
```

## 🐛 Root Cause

The error `22003` (Numeric Value Out of Range) occurs because **Query Parameters in NestJS/Express are Strings by default**, but they are being interpolated directly into a mathematical SQL query without conversion.

When `prisma.$queryRawUnsafe` receives the raw strings `"12.934"` (lat) and `"77.605"` (lng), it attempts to perform trigonometric operations (`cos(radians('12.934'))`) on text types, or binds them incorrectly, causing the database to reject the input or the calculation to overflow.

**Incoming Payload (Confirmed from Logs):**

```json
"query": {
  "lat": "12.93495654",   // <--- String
  "lng": "77.60594496",   // <--- String
  "radius": "10"          // <--- String
}
```

## 🛠 Required Fix

You must **explicitly parse** the query parameters to `numbers` (floats) before using them in your raw SQL query or standard Prisma queries.

### Location: `src/location/location.service.ts`

**Current (Likely Implementation):**

```typescript
// ❌ WRONG: Passing strings directly
async findNearbyNannies(lat: string, lng: string, radius: string) {
  return this.prisma.$queryRawUnsafe(`
    SELECT ...
    WHERE ...
    ... cos(radians(${lat})) ... // interpolation of strings
  `);
}
```

**Corrected Implementation:**

```typescript
// ✅ CORRECT: Parse to Float first
async findNearbyNannies(lat: string, lng: string, radius: string = '10') {
    // 1. Explicit Conversion
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const radiusNum = parseFloat(radius);

    // 2. Validation (Optional but Recommended)
    if (isNaN(latNum) || isNaN(lngNum)) {
        throw new BadRequestException('Invalid coordinates provided');
    }

    // 3. Use numbers in the query
    // NOTE: Using ${latNum} puts the actual number 12.934 into the SQL string, which is valid.
    return await this.prisma.$queryRawUnsafe(`
        SELECT
            p.*,
            u.email,
            (
                6371 * acos(
                    cos(radians(${latNum})) * cos(radians(p.lat)) *
                    cos(radians(p.lng) - radians(${lngNum})) +
                    sin(radians(${latNum})) * sin(radians(p.lat))
                )
            ) AS distance
        FROM users p
        JOIN users u ON p.user_id = u.id
        WHERE
            p.lat IS NOT NULL
            AND p.lng IS NOT NULL
            AND u.role = 'nanny'
            AND (
                6371 * acos(
                    cos(radians(${latNum})) * cos(radians(p.lat)) *
                    cos(radians(p.lng) - radians(${lngNum})) +
                    sin(radians(${latNum})) * sin(radians(p.lat))
                )
            ) < ${radiusNum}
        ORDER BY distance ASC
    `);
}
```

## Context: How It Works

The frontend is strictly following the `Frontend_Location_Handover.md` spec and sending standard HTTP Query Parameters. It is the Backend's responsibility to sanitize and type-cast the inputs before database execution.

- **Frontend sends:** `GET /location/nannies/nearby?lat=12.93&lng=77.60`
- **Backend receives:** `{ lat: "12.93", lng: "77.60" }` (Strings)
- **Database expects:** `12.93` (Float/Double) for `radians()` and arithmetic.
