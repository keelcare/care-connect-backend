/**
 * Development seed.
 *
 * Seeds the configuration the app cannot run without — admin, services, rate
 * cards, pricing settings, an active report template — and nothing else. User
 * data (parents, caregivers, bookings) is deliberately out of scope: it is
 * created through the real signup and onboarding flows.
 *
 * Everything below is idempotent and additive. The one rule worth stating: this
 * script never overwrites a value a human may have set from the admin dashboard
 * — it fills gaps. Rate cards in particular are append-only per the schema, so a
 * rate change closes the old card and inserts a new one rather than updating in
 * place.
 */
import { PrismaClient, report_input_type } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

const ADMIN_EMAIL = "admin@keelcare.com";
const ADMIN_PASSWORD = "keelcarecon123";

/**
 * Current live pricing: every service is ₹99/hr in dev. Kept as one constant
 * because that is how it is actually configured — the per-category rates this
 * script used to seed (350/250/450) were superseded on 2026-07-09.
 */
const HOURLY_RATE = 99.0;

/**
 * Seeded services. `EC` (elderly care) exists in `CATEGORY_SKILL_MAP` but has no
 * service row or rate card in dev, so it is deliberately not seeded here — adding
 * one would make a category bookable that pricing has never been configured for.
 */
const SERVICES = [
  { name: "ST", slug: "shadow-teacher" },
  { name: "CC", slug: "child-care" },
  { name: "SN", slug: "special-needs" },
];

/**
 * Pricing/platform settings, mirroring what dev currently runs with. Seeded only
 * when the key is missing: these are admin-editable, and re-running the seed must
 * not revert someone's experiment.
 */
const SYSTEM_SETTINGS: { key: string; value: unknown }[] = [
  // Platform take rate, as a share of the caregiver's pre-tax service fee.
  { key: "platform_commission_percent", value: { percent: 5 } },
  // One-off placement fee, carved out of the first cycle rather than added to it.
  { key: "matching_fee", value: { enabled: true, amount: 249 } },
  // Days after the advance is captured that the balance half falls due.
  // (Production default is 14; dev runs 1 so the dunning path is testable.)
  { key: "advance_payment_due_days", value: 1 },
  // Kill switch for advance/balance splitting. Absent already means on; seeded
  // explicitly so the switch is discoverable in the settings table.
  { key: "split_payments_enabled", value: true },
];

async function seedAdmin() {
  const existing = await prisma.users.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log("ℹ️  Admin already exists.");
    return;
  }

  const password_hash = await bcrypt.hash(ADMIN_PASSWORD, await bcrypt.genSalt(10));

  await prisma.users.create({
    data: {
      email: ADMIN_EMAIL,
      password_hash,
      role: "admin",
      is_verified: true,
      is_active: true,
      profiles: {
        create: {
          first_name: "Admin",
          last_name: "User",
          phone: "+910000000000",
          address: "Admin HQ",
          onboarding_completed: true,
        },
      },
    },
  });
  console.log(`✅ Admin created (${ADMIN_EMAIL} / ${ADMIN_PASSWORD}).`);
}

/**
 * Services and their active rate card. `rate_cards` is append-only, so a rate that
 * differs from the live card closes that card (`effective_to = now`) and inserts a
 * new one — never an update, or historical `price_snapshots` would stop
 * reconciling against the rate they were charged at.
 */
async function seedServicesAndRates() {
  const now = new Date();

  for (const s of SERVICES) {
    const service = await prisma.services.upsert({
      where: { name: s.name },
      update: { slug: s.slug },
      create: { name: s.name, slug: s.slug },
    });

    const active = await prisma.rate_cards.findFirst({
      where: { service_id: service.id, effective_to: null },
      orderBy: { effective_from: "desc" },
    });

    if (active && Number(active.hourly_rate) === HOURLY_RATE) continue;

    if (active) {
      await prisma.rate_cards.update({
        where: { id: active.id },
        data: { effective_to: now },
      });
      console.log(
        `   ${s.name}: closed rate card @ ₹${active.hourly_rate.toString()}/hr`,
      );
    }

    await prisma.rate_cards.create({
      data: {
        service_id: service.id,
        hourly_rate: HOURLY_RATE,
        effective_from: active ? now : new Date("2025-01-01T00:00:00Z"),
        effective_to: null,
      },
    });
    console.log(`   ${s.name}: active rate card @ ₹${HOURLY_RATE}/hr`);
  }
  console.log(`✅ Seeded ${SERVICES.length} services with rate cards.`);
}

async function seedSystemSettings() {
  let created = 0;
  for (const setting of SYSTEM_SETTINGS) {
    const existing = await prisma.system_settings.findUnique({
      where: { key: setting.key },
    });
    if (existing) continue;
    await prisma.system_settings.create({
      data: { key: setting.key, value: setting.value as never },
    });
    created++;
  }
  console.log(
    `✅ System settings: ${created} created, ${SYSTEM_SETTINGS.length - created} already present.`,
  );
}

/**
 * Progress reports are generated against whichever template is active; with none,
 * `generateReport` logs and returns null and every completed booking silently
 * skips its report. One is seeded only when no active template exists.
 */
async function seedReportTemplate(adminId: string | null) {
  const active = await prisma.report_templates.findFirst({
    where: { is_active: true },
  });
  if (active) {
    console.log("ℹ️  Active report template already exists.");
    return;
  }

  await prisma.report_templates.create({
    data: {
      created_by: adminId,
      is_active: true,
      report_template_questions: {
        create: [
          {
            question_text: "How was the child's overall mood today?",
            input_type: report_input_type.MULTI_CHOICE,
            options: ["Happy", "Calm", "Restless", "Upset"],
            is_required: true,
            display_order: 1,
          },
          {
            question_text: "Rate engagement during the session",
            input_type: report_input_type.RATING,
            is_required: true,
            display_order: 2,
          },
          {
            question_text: "Did the child eat their meals?",
            input_type: report_input_type.YES_NO,
            is_required: true,
            display_order: 3,
          },
          {
            question_text: "Activities covered",
            input_type: report_input_type.TEXT,
            is_required: true,
            display_order: 4,
          },
          {
            question_text: "Anything the parent should know?",
            input_type: report_input_type.TEXT,
            is_required: false,
            display_order: 5,
          },
        ],
      },
    },
  });
  console.log("✅ Seeded default progress-report template (v1, active).");
}

/**
 * Any caregiver without a `nanny_details` row is invisible to matching. Backfill
 * those, and only those — an existing row's categories are left alone. (The old
 * version of this script `set` every caregiver to `["ST","CC"]`, which silently
 * stripped the SN caregivers of their category on each run.)
 */
async function backfillNannyDetails() {
  const missing = await prisma.users.findMany({
    where: { role: "nanny", nanny_details: null },
    select: { id: true, email: true },
  });

  for (const nanny of missing) {
    await prisma.nanny_details.create({
      data: {
        user_id: nanny.id,
        experience_years: 2,
        bio: "Experienced caregiver in dev environment.",
        categories: ["ST", "CC"],
        tags: ["ST", "CC"],
        acceptance_rate: 1.0,
        is_available_now: true,
        auto_accept_bookings: true,
      },
    });
    console.log(`   + nanny_details backfilled for ${nanny.email}`);
  }

  const empty = await prisma.nanny_details.updateMany({
    where: { categories: { isEmpty: true } },
    data: { categories: ["ST", "CC"] },
  });

  console.log(
    `✅ Caregiver details: ${missing.length} backfilled, ${empty.count} given default categories.`,
  );
}

async function main() {
  console.log("🌱 Starting development seeding...\n");

  await seedAdmin();
  await seedServicesAndRates();
  await seedSystemSettings();

  const admin = await prisma.users.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true },
  });
  await seedReportTemplate(admin?.id ?? null);

  await backfillNannyDetails();

  console.log("\n🎉 Seeding completed.");
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
