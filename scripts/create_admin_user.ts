import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    const email = 'admin@careconnect.com';
    const password = 'davanj';
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.users.upsert({
        where: { email },
        update: {
            role: 'admin',
            is_verified: true,
            password_hash: hashedPassword // Update password if user exists, just in case
        },
        create: {
            email,
            password_hash: hashedPassword,
            role: 'admin',
            is_verified: true,
            profiles: {
                create: {
                    first_name: 'Admin',
                    last_name: 'User',
                }
            }
        },
    });

    console.log(`Admin user created/updated: ${user.email}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
