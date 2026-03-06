import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  const notifs = await prisma.notifications.findMany({
    orderBy: { created_at: 'desc' },
    take: 5,
    include: { users: { select: { email: true, role: true } } }
  });
  console.log(JSON.stringify(notifs, null, 2));
}

check();
