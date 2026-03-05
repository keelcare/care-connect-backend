import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixNanny() {
    const email = 'anjaney.mitra@mca.christuniversity.in';
    console.log(`Fixing nanny data for: ${email}`);

    const user = await prisma.users.findUnique({
        where: { email },
    });

    if (!user) {
        console.error('User not found');
        return;
    }

    await prisma.$transaction(async (tx) => {
        // 1. Update user verification status
        await tx.users.update({
            where: { id: user.id },
            data: { identity_verification_status: 'verified' },
        });

        // 2. Upsert nanny details
        // Based on schema.prisma, experience_years IS in nanny_details, but hourly_rate is NOT.
        await tx.nanny_details.upsert({
            where: { user_id: user.id },
            update: {
                is_available_now: true,
                categories: ['ST', 'SN', 'CC', 'EC'],
                skills: ['Shadow Teacher', 'Special Education', 'Infant Care', 'Elderly Care'],
                tags: ['ST', 'SN', 'CC', 'EC'],
                experience_years: 5,
                // hourly_rate: 25, // Removed as it's not in the nanny_details model
            },
            create: {
                user_id: user.id,
                is_available_now: true,
                categories: ['ST', 'SN', 'CC', 'EC'],
                skills: ['Shadow Teacher', 'Special Education', 'Infant Care', 'Elderly Care'],
                tags: ['ST', 'SN', 'CC', 'EC'],
                experience_years: 5,
            },
        });

        console.log('Nanny data updated successfully.');
    });

    await prisma.$disconnect();
}

fixNanny().catch(console.error);
