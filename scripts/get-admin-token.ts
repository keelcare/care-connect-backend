import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

async function getToken() {
  const admin = await prisma.users.findFirst({ where: { role: 'admin' } });
  if (!admin) {
    console.log("No admin found");
    process.exit(1);
  }
  
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is not set — refusing to sign a token with a fallback secret.");
    process.exit(1);
  }

  const token = jwt.sign(
    { sub: admin.id, email: admin.email, role: admin.role },
    process.env.JWT_SECRET
  );
  
  console.log(token);
  process.exit(0);
}

getToken();
