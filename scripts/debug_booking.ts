
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkBooking() {
    const bookingId = 'e278b702-01b5-4c0c-a06e-1d6780ddad0c';
    console.log(`Checking booking: ${bookingId}`);

    const booking = await prisma.bookings.findUnique({
        where: { id: bookingId },
        include: {
            users_bookings_nanny_idTousers: {
                include: { nanny_details: true }
            }
        }
    });

    if (!booking) {
        console.log('Booking not found!');
        return;
    }

    console.log('Booking Found:');
    console.log('Status:', booking.status);
    console.log('Start Time:', booking.start_time);
    console.log('End Time:', booking.end_time);
    console.log('Nanny ID:', booking.nanny_id);
    console.log('Nanny User Found:', !!booking.users_bookings_nanny_idTousers);
    if (booking.users_bookings_nanny_idTousers) {
        console.log('Nanny Details Found:', !!booking.users_bookings_nanny_idTousers.nanny_details);
        if (booking.users_bookings_nanny_idTousers.nanny_details) {
            console.log('Hourly Rate:', booking.users_bookings_nanny_idTousers.nanny_details.hourly_rate);
        }
    }
}

checkBooking()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
