import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resetRequest(requestId: string) {
    console.log(`Resetting request: ${requestId}`);

    const request = await prisma.service_requests.findUnique({
        where: { id: requestId },
        include: { bookings: true }
    });

    if (!request) {
        console.error('Request not found');
        return;
    }

    await prisma.$transaction(async (tx) => {
        // 1. Delete associated assignments for this request to start clean
        await tx.assignments.deleteMany({
            where: { request_id: requestId }
        });

        // 2. Clear booking assignment
        if (request.bookings) {
            // Delete existing chat if any (to avoid conflict during re-assignment)
            const chat = await tx.chats.findFirst({
                where: { booking_id: request.bookings.id }
            });
            if (chat) {
                console.log(`Deleting existing chat: ${chat.id}`);
                await tx.chats.delete({ where: { id: chat.id } });
            }

            await tx.bookings.update({
                where: { id: request.bookings.id },
                data: {
                    nanny_id: null,
                    status: "requested"
                }
            });
        }

        // 3. Reset request status
        await tx.service_requests.update({
            where: { id: requestId },
            data: {
                status: "pending",
                current_assignment_id: null
            }
        });

        console.log('Request reset successfully. You can now try manual assignment again.');
    });

    await prisma.$disconnect();
}

// Get the latest request to reset
async function run() {
    const requestId = '4c49443f-2a8e-42cd-85a0-fe4e5662fe7b';
    await resetRequest(requestId);
}

run();
