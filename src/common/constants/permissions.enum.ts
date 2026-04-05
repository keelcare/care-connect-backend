export enum Permission {
    // User Management
    USER_READ = 'user:read',
    USER_WRITE = 'user:write',
    USER_DELETE = 'user:delete',

    // Bookings
    BOOKING_READ = 'booking:read',
    BOOKING_WRITE = 'booking:write',

    // System
    SYSTEM_SETTINGS = 'system:settings',
}

export const ROLES_PERSMISSIONS = {
    admin: [
        Permission.USER_READ,
        Permission.USER_WRITE,
        Permission.USER_DELETE,
        Permission.BOOKING_READ,
        Permission.BOOKING_WRITE,
        Permission.SYSTEM_SETTINGS
    ],
    parent: [
        Permission.USER_READ,
        Permission.USER_WRITE,
        Permission.BOOKING_READ,
        Permission.BOOKING_WRITE
    ],
    nanny: [
        Permission.USER_READ,
        Permission.USER_WRITE,
        Permission.BOOKING_READ,
        Permission.BOOKING_WRITE
    ]
};
