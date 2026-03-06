import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function reproduce() {
    const requestId = '4c49443f-2a8e-42cd-85a0-fe4e5662fe7b'; // Use the same request

    const request = await prisma.service_requests.findUnique({
        where: { id: requestId },
        include: { bookings: true }
    });

    if (!request || !request.bookings) {
        console.log('Request or booking not found.');
        return;
    }

    const bookingId = request.bookings.id;
    console.log(`Testing side effects for Booking: ${bookingId}`);

    // Test 1: Simulate chat creation logic (if we can find where ChatService is)
    console.log('--- Checking Chat Logic ---');
    const chat = await prisma.chats.findFirst({
        where: { booking_id: bookingId }
    });
    console.log(`Chat exists: ${!!chat}`);

    // Test 2: Simulate Notification creation
    console.log('--- Testing Notification Creation ---');
    try {
        const notification = await prisma.notifications.create({
            data: {
                user_id: request.parent_id,
                title: "Test Notification",
                message: "Reproduction test",
                type: "success",
            }
        });
        console.log('Notification created successfully:', notification.id);
    } catch (e) {
        console.error('Notification creation FAILED:', e);
    }

    await prisma.$disconnect();
}

reproduce();
