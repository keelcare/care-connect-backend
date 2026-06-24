import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    console.log('Starting seed...');

    // ── 0. Services (slugs + rate cards) ─────────────────────────────────────
    console.log('Creating services and rate cards...');

    const serviceData = [
        { name: 'CC', slug: 'child-care', hourlyRate: 200.0 },
        { name: 'ST', slug: 'shadow-teacher', hourlyRate: 200.0 },
        { name: 'SN', slug: 'special-needs', hourlyRate: 300.0 },
        { name: 'EC', slug: 'elder-care', hourlyRate: 200.0 },
    ];

    const serviceMap: Record<string, string> = {};

    for (const sd of serviceData) {
        const service = await prisma.services.upsert({
            where: { name: sd.name },
            update: { slug: sd.slug },
            create: { name: sd.name, slug: sd.slug },
        });
        serviceMap[sd.name] = service.id;
        console.log(`  Service: ${sd.name} (${service.id})`);

        // Seed an initial rate card if none exists
        const existing = await prisma.rate_cards.findFirst({
            where: { service_id: service.id, effective_to: null },
        });
        if (!existing) {
            await prisma.rate_cards.create({
                data: {
                    service_id: service.id,
                    hourly_rate: sd.hourlyRate,
                    effective_from: new Date('2025-01-01T00:00:00Z'),
                    effective_to: null,
                },
            });
            console.log(`  Rate card created: ₹${sd.hourlyRate}/hr for ${sd.name}`);
        }
    }

    // ── 1. Discount Tiers ─────────────────────────────────────────────────────
    console.log('Creating discount tiers...');
    const tiers = [
        { code: 'monthly', label: '1 Month', durationMonths: 1, discountPercent: 0 },
        { code: 'half_yearly', label: '6 Months (5% off)', durationMonths: 6, discountPercent: 5 },
        { code: 'yearly', label: '12 Months (10% off)', durationMonths: 12, discountPercent: 10 },
    ];

    for (const t of tiers) {
        await prisma.discount_tiers.upsert({
            where: { code: t.code },
            update: {
                label: t.label,
                duration_months: t.durationMonths,
                discount_percent: t.discountPercent,
            },
            create: {
                code: t.code,
                label: t.label,
                duration_months: t.durationMonths,
                discount_percent: t.discountPercent,
                active: true,
            },
        });
        console.log(`  Tier: ${t.code} (${t.discountPercent}% off)`);
    }

    // ── 2. Clean up existing demo users ─────────────────────────────────────
    console.log('Cleaning up existing demo users...');
    await prisma.users.deleteMany({
        where: { email: { endsWith: '@example.com' } },
    });

    const hashedPassword = await bcrypt.hash('password', 10);

    // ── 3. Parent User ───────────────────────────────────────────────────────
    const parentEmail = 'parent@example.com';
    const parent = await prisma.users.upsert({
        where: { email: parentEmail },
        update: {},
        create: {
            email: parentEmail,
            password_hash: hashedPassword,
            role: 'parent',
            is_verified: true,
            identity_verification_status: 'verified',
            profiles: {
                create: {
                    first_name: 'Rajesh',
                    last_name: 'Sharma',
                    phone: '+919876543210',
                    address: 'Bandra West, Mumbai, Maharashtra 400050',
                    lat: 19.0596,
                    lng: 72.8295,
                },
            },
        },
    });
    console.log({ parent });

    // ── 4. Admin User ────────────────────────────────────────────────────────
    const adminEmail = 'admin@example.com';
    const admin = await prisma.users.upsert({
        where: { email: adminEmail },
        update: {},
        create: {
            email: adminEmail,
            password_hash: hashedPassword,
            role: 'admin',
            is_verified: true,
            identity_verification_status: 'verified',
            profiles: {
                create: {
                    first_name: 'Super',
                    last_name: 'Admin',
                    phone: '+1000000000',
                },
            },
        },
    });
    console.log({ admin });

    // ── 5. Nanny Users ───────────────────────────────────────────────────────
    const nanny = await prisma.users.upsert({
        where: { email: 'priya.patel@example.com' },
        update: {},
        create: {
            email: 'priya.patel@example.com',
            password_hash: hashedPassword,
            role: 'nanny',
            is_verified: true,
            identity_verification_status: 'verified',
            profiles: {
                create: {
                    first_name: 'Priya',
                    last_name: 'Patel',
                    phone: '+919123456789',
                    address: 'Andheri East, Mumbai, Maharashtra 400069',
                    lat: 19.1136,
                    lng: 72.8697,
                },
            },
            nanny_details: {
                create: {
                    skills: ['First Aid', 'Cooking', 'Hindi', 'English'],
                    experience_years: 5,
                    bio: 'Experienced nanny with 5 years of childcare experience.',
                    availability_schedule: {
                        monday: ['09:00-17:00'],
                        tuesday: ['09:00-17:00'],
                        wednesday: ['09:00-17:00'],
                        thursday: ['09:00-17:00'],
                        friday: ['09:00-17:00'],
                    },
                    is_available_now: true,
                    tags: ['NY'],
                },
            },
        },
    });

    const nanny2 = await prisma.users.upsert({
        where: { email: 'sunita.desai@example.com' },
        update: {},
        create: {
            email: 'sunita.desai@example.com',
            password_hash: hashedPassword,
            role: 'nanny',
            is_verified: true,
            identity_verification_status: 'verified',
            profiles: {
                create: {
                    first_name: 'Sunita',
                    last_name: 'Desai',
                    phone: '+919988776655',
                    address: 'Powai, Mumbai, Maharashtra 400076',
                    lat: 19.1197,
                    lng: 72.9059,
                },
            },
            nanny_details: {
                create: {
                    skills: ['Music', 'Art', 'Swimming', 'Marathi', 'English'],
                    experience_years: 3,
                    bio: 'Creative nanny with background in arts and music.',
                    availability_schedule: {
                        monday: ['10:00-18:00'],
                        wednesday: ['10:00-18:00'],
                        friday: ['10:00-18:00'],
                        saturday: ['09:00-13:00'],
                    },
                    is_available_now: true,
                    tags: ['NY'],
                },
            },
        },
    });

    // Bangalore nannies
    const bangaloreNannies = [
        { email: 'lakshmi.reddy@example.com', firstName: 'Lakshmi', lastName: 'Reddy', phone: '+918899776655', address: 'Koramangala, Bangalore, Karnataka 560034', lat: 12.9352, lng: 77.6245, skills: ['First Aid', 'Cooking', 'Kannada', 'English', 'Tamil'], exp: 7, bio: 'Highly experienced nanny. Specialized in infant care.', tags: ['SN'] },
        { email: 'riya.sharma@example.com', firstName: 'Riya', lastName: 'Sharma', phone: '+919876500001', address: 'Indiranagar, Bangalore', lat: 12.9716, lng: 77.6412, skills: ['Toddlers', 'Arts', 'English', 'Hindi'], exp: 4, bio: 'Energetic nanny who loves creative arts.', tags: ['Standard'] },
        { email: 'ananya.gupta@example.com', firstName: 'Ananya', lastName: 'Gupta', phone: '+919876500002', address: 'Whitefield, Bangalore', lat: 12.9698, lng: 77.7500, skills: ['Homework Help', 'English', 'Math'], exp: 2, bio: 'University student for part-time babysitting.', tags: ['Standard'] },
        { email: 'kavita.singh@example.com', firstName: 'Kavita', lastName: 'Singh', phone: '+919876500003', address: 'HSR Layout, Bangalore', lat: 12.9121, lng: 77.6446, skills: ['Cooking', 'Housekeeping', 'Hindi', 'Kannada'], exp: 8, bio: 'Reliable and experienced caregiver.', tags: ['Premium'] },
        { email: 'deepa.rao@example.com', firstName: 'Deepa', lastName: 'Rao', phone: '+919876500004', address: 'Jayanagar, Bangalore', lat: 12.9308, lng: 77.5838, skills: ['Elderly Care', 'First Aid', 'Kannada', 'Telugu'], exp: 10, bio: 'Certified caregiver with a decade of experience.', tags: ['Premium'] },
        { email: 'manju.thomas@example.com', firstName: 'Manju', lastName: 'Thomas', phone: '+919876500005', address: 'Electronic City, Bangalore', lat: 12.8452, lng: 77.6602, skills: ['Infant Care', 'Malayalam', 'English'], exp: 6, bio: 'Specialized in newborn care.', tags: ['Premium'] },
    ];

    for (const n of bangaloreNannies) {
        await prisma.users.upsert({
            where: { email: n.email },
            update: {},
            create: {
                email: n.email,
                password_hash: hashedPassword,
                role: 'nanny',
                is_verified: true,
                identity_verification_status: 'verified',
                profiles: { create: { first_name: n.firstName, last_name: n.lastName, phone: n.phone, address: n.address, lat: n.lat, lng: n.lng } },
                nanny_details: { create: { skills: n.skills, experience_years: n.exp, bio: n.bio, availability_schedule: { monday: ['09:00-18:00'], tuesday: ['09:00-18:00'], wednesday: ['09:00-18:00'], thursday: ['09:00-18:00'], friday: ['09:00-18:00'] }, is_available_now: true, tags: n.tags } },
            },
        });
        console.log(`Created Bangalore nanny: ${n.firstName}`);
    }

    // Delhi
    await prisma.users.upsert({
        where: { email: 'vikram.singh@example.com' },
        update: {},
        create: {
            email: 'vikram.singh@example.com',
            password_hash: hashedPassword,
            role: 'parent',
            is_verified: true,
            identity_verification_status: 'verified',
            profiles: { create: { first_name: 'Vikram', last_name: 'Singh', phone: '+919811122233', address: 'Vasant Kunj, New Delhi, Delhi 110070', lat: 28.5293, lng: 77.1509 } },
        },
    });

    const delhiNannies = [
        { email: 'meera.devi@example.com', firstName: 'Meera', lastName: 'Devi', phone: '+919811100001', address: 'Saket, New Delhi', lat: 28.5246, lng: 77.2066, skills: ['Cooking', 'Hindi'], exp: 12, bio: 'Mature and responsible nanny.', tags: ['Standard'] },
        { email: 'pooja.rani@example.com', firstName: 'Pooja', lastName: 'Rani', phone: '+919811100002', address: 'Hauz Khas, New Delhi', lat: 28.5494, lng: 77.2001, skills: ['Sports', 'English', 'Hindi'], exp: 3, bio: 'Active and energetic nanny.', tags: ['Standard'] },
    ];
    for (const n of delhiNannies) {
        await prisma.users.upsert({
            where: { email: n.email },
            update: {},
            create: {
                email: n.email,
                password_hash: hashedPassword,
                role: 'nanny',
                is_verified: true,
                identity_verification_status: 'verified',
                profiles: { create: { first_name: n.firstName, last_name: n.lastName, phone: n.phone, address: n.address, lat: n.lat, lng: n.lng } },
                nanny_details: { create: { skills: n.skills, experience_years: n.exp, bio: n.bio, availability_schedule: { monday: ['10:00-19:00'], wednesday: ['10:00-19:00'], friday: ['10:00-19:00'] }, is_available_now: true, tags: n.tags } },
            },
        });
        console.log(`Created Delhi nanny: ${n.firstName}`);
    }

    // Hyderabad
    await prisma.users.upsert({
        where: { email: 'sanya.mirza@example.com' },
        update: {},
        create: {
            email: 'sanya.mirza@example.com',
            password_hash: hashedPassword,
            role: 'nanny',
            is_verified: true,
            identity_verification_status: 'verified',
            profiles: { create: { first_name: 'Sanya', last_name: 'Mirza', phone: '+919900088877', address: 'Jubilee Hills, Hyderabad', lat: 17.4326, lng: 78.4071 } },
            nanny_details: { create: { skills: ['Special Needs', 'English', 'Telugu', 'Urdu'], experience_years: 9, bio: 'Premium care provider. Experienced with special needs children.', availability_schedule: { monday: ['08:00-20:00'], tuesday: ['08:00-20:00'], wednesday: ['08:00-20:00'], thursday: ['08:00-20:00'], friday: ['08:00-20:00'], saturday: ['09:00-14:00'] }, is_available_now: true, tags: ['EC'] } },
        },
    });
    console.log('Created Hyderabad nanny: Sanya');

    // ── 6. Sample Jobs ───────────────────────────────────────────────────────
    const job1 = await prisma.jobs.upsert({
        where: { id: '00000000-0000-0000-0000-000000000001' },
        update: { description: 'Need a babysitter for Saturday evening. Two kids aged 3 and 5.', location_lat: 19.0760, location_lng: 72.8263 },
        create: { id: '00000000-0000-0000-0000-000000000001', parent_id: parent.id, title: 'Weekend Babysitting', description: 'Need a babysitter for Saturday evening. Two kids aged 3 and 5.', date: new Date('2025-12-01'), time: new Date('2025-12-01T18:00:00'), location_lat: 19.0760, location_lng: 72.8263, status: 'open' },
    });
    const job2 = await prisma.jobs.upsert({
        where: { id: '00000000-0000-0000-0000-000000000002' },
        update: { description: 'Looking for after school care for 2 kids.', location_lat: 19.0330, location_lng: 72.8326 },
        create: { id: '00000000-0000-0000-0000-000000000002', parent_id: parent.id, title: 'After School Care', description: 'Looking for after school care for 2 kids.', date: new Date('2025-12-05'), time: new Date('2025-12-05T15:00:00'), location_lat: 19.0330, location_lng: 72.8326, status: 'open' },
    });
    const job3 = await prisma.jobs.upsert({
        where: { id: '00000000-0000-0000-0000-000000000003' },
        update: {},
        create: { id: '00000000-0000-0000-0000-000000000003', parent_id: parent.id, title: 'Full Day Nanny Required', description: 'Need a full-time nanny for infant care.', date: new Date('2025-12-10'), time: new Date('2025-12-10T09:00:00'), location_lat: 19.1075, location_lng: 72.8479, status: 'open' },
    });
    console.log({ job1, job2, job3 });

    // ── 7. Support Tickets ───────────────────────────────────────────────────
    console.log('Creating support tickets...');
    await prisma.support_tickets.upsert({ where: { ticket_number: 'TIC-1001' }, update: {}, create: { ticket_number: 'TIC-1001', user_id: parent.id, role: 'parent', subject: 'Issue with booking payment', description: 'I was charged twice for my last booking.', category: 'payment', priority: 'high', status: 'open' } });
    await prisma.support_tickets.upsert({ where: { ticket_number: 'TIC-1002' }, update: {}, create: { ticket_number: 'TIC-1002', user_id: nanny.id, role: 'nanny', subject: 'App crashing on startup', description: 'Every time I open the app, it crashes.', category: 'technical', priority: 'medium', status: 'open' } });
    await prisma.support_tickets.upsert({ where: { ticket_number: 'TIC-1003' }, update: {}, create: { ticket_number: 'TIC-1003', user_id: nanny2.id, role: 'nanny', subject: 'Inappropriate behavior from parent', description: 'A parent was very rude during the last visit.', category: 'grievance', priority: 'critical', status: 'open' } });

    console.log('Seed completed successfully ✅');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
