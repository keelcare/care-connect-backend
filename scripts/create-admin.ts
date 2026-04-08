import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const email = "admin@keelcare.com";
  const password = "keelcarecon123";

  // Check if admin exists
  const existing = await prisma.users.findUnique({
    where: { email },
  });

  if (existing) {
    console.log(`Admin user already exists: ${email}`);
    process.exit(0);
  }

  // Hash password
  const salt = await bcrypt.genSalt(10);
  const password_hash = await bcrypt.hash(password, salt);

  // Create admin
  const user = await prisma.users.create({
    data: {
      email,
      password_hash,
      role: "admin",
      is_verified: true,
      profiles: {
        create: {
          first_name: "Admin",
          last_name: "User",
          phone: "+910000000000",
          address: "Admin HQ",
        }
      }
    },
  });

  console.log("✅ Admin user created successfully!");
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
