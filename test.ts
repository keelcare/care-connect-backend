import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.service_requests.findMany({
  where: {
    bookings: {
      isNot: null
    }
  }
});
