
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkLatestBooking() {
    console.log('Checking latest booking for payment data validity...');

    const booking = await prisma.bookings.findFirst({
        orderBy: { created_at: 'desc' },
        include: {
            users_bookings_nanny_idTousers: {
                include: {
                    nanny_details: true,
                }
            }
        }
    });

    if (!booking) {
        console.log('No bookings found in the database.');
        return;
    }

    console.log('Latest Booking ID:', booking.id);
    console.log('Status:', booking.status);
    console.log('Start Time:', booking.start_time);
    console.log('End Time:', booking.end_time);

    const nannyUser = booking.users_bookings_nanny_idTousers;
    if (!nannyUser) {
        console.log('ERROR: No nanny user associated with this booking.');
    } else {
        console.log('Nanny ID:', nannyUser.id);
        const details = nannyUser.nanny_details;
        if (!details) {
            console.log('ERROR: No nanny_details found for the nanny user.');
        } else {
            console.log('Hourly Rate:', details.hourly_rate);

            if (!details.hourly_rate || Number(details.hourly_rate) === 0) {
                console.log('POTENTIAL ISSUE: Hourly rate is missing or 0.');
            }
        }
    }

    if (booking.start_time && booking.end_time) {
        const duration = (new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / (1000 * 60 * 60);
        console.log('Calculated Duration (hours):', duration);

        if (duration <= 0) {
            console.log('POTENTIAL ISSUE: Duration is 0 or negative.');
        }

        const rate = Number(nannyUser?.nanny_details?.hourly_rate || 0);
        const amount = rate * duration;
        console.log('Calculated Amount (INR):', amount);

        if (amount <= 0) {
            console.log('POTENTIAL ISSUE: Calculated amount is 0.');
        }
    } else {
        console.log('POTENTIAL ISSUE: Missing start or end time on booking.');
    }

}

checkLatestBooking()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
