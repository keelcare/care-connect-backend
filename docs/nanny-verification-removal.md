# Nanny Verification Removal (Temporary for Testing)

To facilitate smooth end-to-end testing and development of the nanny assignment and booking flows, the strict requirement for nannies to be "verified" has been temporarily relaxed across the backend services.

## Why was this done?
Enforcing verification during the early stages of E2E testing added friction for creating and testing new nanny accounts. By making verification optional in the logic, we can test the entire lifecycle (Match -> Assign -> Book -> Start -> Complete) with any nanny account.

## Locations of Changes

The following services were modified to remove or comment out the `identity_verification_status = 'verified'` check:

1.  **AdminService** (`src/admin/admin.service.ts`):
    - Modified `getAvailableNanniesForRequest` (Raw SQL query) to include unverified nannies in manual assignment results.
2.  **RequestsService** (`src/requests/requests.service.ts`):
    - Modified `triggerMatching` (Raw SQL query) to allow auto-matching to pick unverified nannies.
3.  **BookingsService** (`src/bookings/bookings.service.ts`):
    - Commented out the verification check in `createBooking` to allow booking creation for unverified nannies.
4.  **UsersService** (`src/users/users.service.ts`):
    - Commented out the verification filter in `findAllNannies` to show all nannies in listings.

## How to restore?
To re-enable strict verification, simply uncomment or restore the `identity_verification_status` checks in the aforementioned files.

> [!IMPORTANT]
> This is a development-time relaxation. Ensure this is reverted or properly integrated with a real verification provider before production deployment.
