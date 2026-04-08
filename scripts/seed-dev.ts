import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting development seeding...");

  // 1. Create/Update Admin Account
  const adminEmail = "admin@keelcare.com";
  const adminPassword = "keelcarecon123";
  
  const existingAdmin = await prisma.users.findUnique({
    where: { email: adminEmail },
  });

  if (!existingAdmin) {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(adminPassword, salt);

    await prisma.users.create({
      data: {
        email: adminEmail,
        password_hash,
        role: "admin",
        is_verified: true,
        profiles: {
          create: {
            first_name: "Admin",
            last_name: "User",
            phone: "+910000000000",
            address: "Admin HQ",
          },
        },
      },
    });
    console.log("✅ Admin user created.");
  } else {
    console.log("ℹ️ Admin user already exists.");
  }

  // 2. Seed Service Categories (Required for matching and pricing)
  const services = [
    { name: "ST", hourly_rate: 350.0 }, // Shadow Teacher
    { name: "CN", hourly_rate: 250.0 }, // Child Care
    { name: "SN", hourly_rate: 450.0 }, // Special Needs
  ];

  for (const service of services) {
    await prisma.services.upsert({
      where: { name: service.name },
      update: { hourly_rate: service.hourly_rate },
      create: { 
        name: service.name, 
        hourly_rate: service.hourly_rate 
      },
    });
  }
  console.log(`✅ Seeded ${services.length} service categories.`);

  // 3. Initialize Nanny Details and Categories
  const nannies = await prisma.users.findMany({
    where: { role: "nanny" },
    include: { nanny_details: true },
  });

  console.log(`📊 Found ${nannies.length} nannies to initialize.`);

  for (const nanny of nannies) {
    // Ensure nanny_details exists and has categories
    await prisma.nanny_details.upsert({
      where: { user_id: nanny.id },
      update: {
        categories: {
            set: ["ST", "CN"], // Default both for dev nannies to ensure they show up in searches
        }
      },
      create: {
        user_id: nanny.id,
        experience_years: 2,
        bio: "Experienced caregiver in dev environment.",
        categories: ["ST", "CN"],
        acceptance_rate: 1.0,
        is_available_now: true,
      },
    });
  }
  console.log(`✅ Initialized categories for ${nannies.length} nannies.`);

  console.log("🎉 Seeding completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
