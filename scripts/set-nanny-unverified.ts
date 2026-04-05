import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const email = 'anjaney.mitra@mca.christuniversity.in';

    console.log(`Setting nanny ${email} to UNVERIFIED for testing...`);

    const user = await prisma.users.update({
        where: { email },
        data: {
            identity_verification_status: 'unverified',
            is_verified: false,
            nanny_details: {
                update: {
                    is_available_now: true,
                    skills: ['Shadow Teacher', 'Special Education', 'ST', 'SN'],
                }
            }
        }
    });

    console.log('Nanny updated successfully:', {
        email: user.email,
        status: user.identity_verification_status,
        is_verified: user.is_verified
    });

    await prisma.$disconnect();
}

main().catch(console.error);
