import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    // Create a Parent User with location in Mumbai
    const parentEmail = 'parent@example.com';
    const parent = await prisma.users.upsert({
        where: { email: parentEmail },
        update: {},
        create: {
            email: parentEmail,
            password_hash: 'dummy_hash', // In real app, this would be hashed
            role: 'parent',
            is_verified: true,
            profiles: {
                create: {
                    first_name: 'Rajesh',
                    last_name: 'Sharma',
                    phone: '+919876543210',
                    address: 'Bandra West, Mumbai, Maharashtra 400050',
                    lat: 19.0596, // Bandra, Mumbai coordinates
                    lng: 72.8295,
                },
            },
        },
    });
    console.log({ parent });

    // Create a Nanny User with location in Mumbai
    const nannyEmail = 'nanny@example.com';
    const nanny = await prisma.users.upsert({
        where: { email: nannyEmail },
        update: {},
        create: {
            email: nannyEmail,
            password_hash: 'dummy_hash',
            role: 'nanny',
            is_verified: true,
            profiles: {
                create: {
                    first_name: 'Priya',
                    last_name: 'Patel',
                    phone: '+919123456789',
                    address: 'Andheri East, Mumbai, Maharashtra 400069',
                    lat: 19.1136, // Andheri, Mumbai coordinates
                    lng: 72.8697,
                },
            },
            nanny_details: {
                create: {
                    skills: ['First Aid', 'Cooking', 'Hindi', 'English'],
                    experience_years: 5,
                    hourly_rate: 300.0, // INR per hour
                    bio: 'Experienced nanny with 5 years of childcare experience. Fluent in Hindi and English.',
                    availability_schedule: {
                        monday: ['09:00-17:00'],
                        tuesday: ['09:00-17:00'],
                        wednesday: ['09:00-17:00'],
                        thursday: ['09:00-17:00'],
                        friday: ['09:00-17:00'],
                    },
                },
            },
        },
    });
    console.log({ nanny });

    // Create another nanny in Mumbai for testing nearby searches
    const nanny2Email = 'nanny2@example.com';
    const nanny2 = await prisma.users.upsert({
        where: { email: nanny2Email },
        update: {},
        create: {
            email: nanny2Email,
            password_hash: 'dummy_hash',
            role: 'nanny',
            is_verified: true,
            profiles: {
                create: {
                    first_name: 'Sunita',
                    last_name: 'Desai',
                    phone: '+919988776655',
                    address: 'Powai, Mumbai, Maharashtra 400076',
                    lat: 19.1197, // Powai, Mumbai coordinates
                    lng: 72.9059,
                },
            },
            nanny_details: {
                create: {
                    skills: ['Music', 'Art', 'Swimming', 'Marathi', 'English'],
                    experience_years: 3,
                    hourly_rate: 250.0, // INR per hour
                    bio: 'Creative nanny with background in arts and music. Great with toddlers.',
                    availability_schedule: {
                        monday: ['10:00-18:00'],
                        wednesday: ['10:00-18:00'],
                        friday: ['10:00-18:00'],
                        saturday: ['09:00-13:00'],
                    },
                },
            },
        },
    });
    console.log({ nanny2 });

    // Create a nanny in Bangalore for testing
    const nanny3Email = 'nanny3@example.com';
    const nanny3 = await prisma.users.upsert({
        where: { email: nanny3Email },
        update: {},
        create: {
            email: nanny3Email,
            password_hash: 'dummy_hash',
            role: 'nanny',
            is_verified: true,
            profiles: {
                create: {
                    first_name: 'Lakshmi',
                    last_name: 'Reddy',
                    phone: '+918899776655',
                    address: 'Koramangala, Bangalore, Karnataka 560034',
                    lat: 12.9352, // Koramangala, Bangalore coordinates
                    lng: 77.6245,
                },
            },
            nanny_details: {
                create: {
                    skills: ['First Aid', 'Cooking', 'Kannada', 'English', 'Tamil'],
                    experience_years: 7,
                    hourly_rate: 350.0, // INR per hour
                    bio: 'Highly experienced nanny with excellent references. Specialized in infant care.',
                    availability_schedule: {
                        monday: ['08:00-16:00'],
                        tuesday: ['08:00-16:00'],
                        wednesday: ['08:00-16:00'],
                        thursday: ['08:00-16:00'],
                        friday: ['08:00-16:00'],
                    },
                },
            },
        },
    });
    console.log({ nanny3 });

    // Create sample jobs with location data in Mumbai
    const job1 = await prisma.jobs.upsert({
        where: { id: '00000000-0000-0000-0000-000000000001' },
        update: {
            description: 'Need a babysitter for Saturday evening. Two kids aged 3 and 5.',
            location_lat: 19.0760, // Juhu, Mumbai
            location_lng: 72.8263,
        },
        create: {
            id: '00000000-0000-0000-0000-000000000001',
            parent_id: parent.id,
            title: 'Weekend Babysitting',
            description: 'Need a babysitter for Saturday evening. Two kids aged 3 and 5.',
            date: new Date('2025-12-01'),
            time: new Date('2025-12-01T18:00:00'),
            location_lat: 19.0760, // Juhu, Mumbai
            location_lng: 72.8263,
            status: 'open',
        },
    });
    console.log({ job1 });

    const job2 = await prisma.jobs.upsert({
        where: { id: '00000000-0000-0000-0000-000000000002' },
        update: {
            description: 'Looking for after school care for 2 kids. Pick up from school and help with homework.',
            location_lat: 19.0330, // Lower Parel, Mumbai
            location_lng: 72.8326,
        },
        create: {
            id: '00000000-0000-0000-0000-000000000002',
            parent_id: parent.id,
            title: 'After School Care',
            description: 'Looking for after school care for 2 kids. Pick up from school and help with homework.',
            date: new Date('2025-12-05'),
            time: new Date('2025-12-05T15:00:00'),
            location_lat: 19.0330, // Lower Parel, Mumbai
            location_lng: 72.8326,
            status: 'open',
        },
    });
    console.log({ job2 });

    const job3 = await prisma.jobs.upsert({
        where: { id: '00000000-0000-0000-0000-000000000003' },
        update: {},
        create: {
            id: '00000000-0000-0000-0000-000000000003',
            parent_id: parent.id,
            title: 'Full Day Nanny Required',
            description: 'Need a full-time nanny for infant care. Monday to Friday.',
            date: new Date('2025-12-10'),
            time: new Date('2025-12-10T09:00:00'),
            location_lat: 19.1075, // Goregaon, Mumbai
            location_lng: 72.8479,
            status: 'open',
        },
    });
    console.log({ job3 });
    // --- Additional Bangalore Nannies ---
    const bangaloreNannies = [
        {
            email: 'riya.sharma@example.com',
            firstName: 'Riya',
            lastName: 'Sharma',
            phone: '+919876500001',
            address: 'Indiranagar, Bangalore, Karnataka 560038',
            lat: 12.9716,
            lng: 77.6412,
            skills: ['Toddlers', 'Arts', 'English', 'Hindi'],
            exp: 4,
            rate: 300.0,
            bio: 'Energetic nanny who loves engaging kids in creative arts and crafts.',
        },
        {
            email: 'ananya.gupta@example.com',
            firstName: 'Ananya',
            lastName: 'Gupta',
            phone: '+919876500002',
            address: 'Whitefield, Bangalore, Karnataka 560066',
            lat: 12.9698,
            lng: 77.7500,
            skills: ['Homework Help', 'English', 'Math'],
            exp: 2,
            rate: 200.0,
            bio: 'University student available for part-time babysitting and homework help.',
        },
        {
            email: 'kavita.singh@example.com',
            firstName: 'Kavita',
            lastName: 'Singh',
            phone: '+919876500003',
            address: 'HSR Layout, Bangalore, Karnataka 560102',
            lat: 12.9121,
            lng: 77.6446,
            skills: ['Cooking', 'Housekeeping', 'Hindi', 'Kannada'],
            exp: 8,
            rate: 400.0,
            bio: 'Reliable and experienced. Can manage household chores along with childcare.',
        },
        {
            email: 'deepa.rao@example.com',
            firstName: 'Deepa',
            lastName: 'Rao',
            phone: '+919876500004',
            address: 'Jayanagar, Bangalore, Karnataka 560041',
            lat: 12.9308,
            lng: 77.5838,
            skills: ['Elderly Care', 'First Aid', 'Kannada', 'Telugu'],
            exp: 10,
            rate: 450.0,
            bio: 'Certified caregiver with a decade of experience in both child and elderly care.',
        },
        {
            email: 'manju.thomas@example.com',
            firstName: 'Manju',
            lastName: 'Thomas',
            phone: '+919876500005',
            address: 'Electronic City, Bangalore, Karnataka 560100',
            lat: 12.8452,
            lng: 77.6602,
            skills: ['Infant Care', 'Malayalam', 'English'],
            exp: 6,
            rate: 350.0,
            bio: 'Specialized in newborn care and post-partum support for mothers.',
        },
    ];

    for (const n of bangaloreNannies) {
        await prisma.users.upsert({
            where: { email: n.email },
            update: {},
            create: {
                email: n.email,
                password_hash: 'dummy_hash',
                role: 'nanny',
                is_verified: true,
                profiles: {
                    create: {
                        first_name: n.firstName,
                        last_name: n.lastName,
                        phone: n.phone,
                        address: n.address,
                        lat: n.lat,
                        lng: n.lng,
                    },
                },
                nanny_details: {
                    create: {
                        skills: n.skills,
                        experience_years: n.exp,
                        hourly_rate: n.rate,
                        bio: n.bio,
                        availability_schedule: {
                            monday: ['09:00-18:00'],
                            tuesday: ['09:00-18:00'],
                            wednesday: ['09:00-18:00'],
                            thursday: ['09:00-18:00'],
                            friday: ['09:00-18:00'],
                        },
                    },
                },
            },
        });
        console.log(`Created Bangalore nanny: ${n.firstName}`);
    }

    // --- Delhi Data ---
    // Parent
    const delhiParentEmail = 'vikram.singh@example.com';
    await prisma.users.upsert({
        where: { email: delhiParentEmail },
        update: {},
        create: {
            email: delhiParentEmail,
            password_hash: 'dummy_hash',
            role: 'parent',
            is_verified: true,
            profiles: {
                create: {
                    first_name: 'Vikram',
                    last_name: 'Singh',
                    phone: '+919811122233',
                    address: 'Vasant Kunj, New Delhi, Delhi 110070',
                    lat: 28.5293,
                    lng: 77.1509,
                },
            },
        },
    });
    console.log('Created Delhi parent: Vikram');

    // Nannies
    const delhiNannies = [
        {
            email: 'meera.devi@example.com',
            firstName: 'Meera',
            lastName: 'Devi',
            phone: '+919811100001',
            address: 'Saket, New Delhi, Delhi 110017',
            lat: 28.5246,
            lng: 77.2066,
            skills: ['Cooking', 'Hindi'],
            exp: 12,
            rate: 300.0,
            bio: 'Mature and responsible nanny. Very good with cooking healthy meals.',
        },
        {
            email: 'pooja.rani@example.com',
            firstName: 'Pooja',
            lastName: 'Rani',
            phone: '+919811100002',
            address: 'Hauz Khas, New Delhi, Delhi 110016',
            lat: 28.5494,
            lng: 77.2001,
            skills: ['Sports', 'English', 'Hindi'],
            exp: 3,
            rate: 250.0,
            bio: 'Active and energetic. Loves taking kids to the park and playing sports.',
        },
    ];

    for (const n of delhiNannies) {
        await prisma.users.upsert({
            where: { email: n.email },
            update: {},
            create: {
                email: n.email,
                password_hash: 'dummy_hash',
                role: 'nanny',
                is_verified: true,
                profiles: {
                    create: {
                        first_name: n.firstName,
                        last_name: n.lastName,
                        phone: n.phone,
                        address: n.address,
                        lat: n.lat,
                        lng: n.lng,
                    },
                },
                nanny_details: {
                    create: {
                        skills: n.skills,
                        experience_years: n.exp,
                        hourly_rate: n.rate,
                        bio: n.bio,
                        availability_schedule: {
                            monday: ['10:00-19:00'],
                            wednesday: ['10:00-19:00'],
                            friday: ['10:00-19:00'],
                        },
                    },
                },
            },
        });
        console.log(`Created Delhi nanny: ${n.firstName}`);
    }

    // --- Hyderabad Data ---
    const hyderabadNanny = {
        email: 'sanya.mirza@example.com',
        firstName: 'Sanya',
        lastName: 'Mirza',
        phone: '+919900088877',
        address: 'Jubilee Hills, Hyderabad, Telangana 500033',
        lat: 17.4326,
        lng: 78.4071,
        skills: ['Special Needs', 'English', 'Telugu', 'Urdu'],
        exp: 9,
        rate: 600.0,
        bio: 'Premium care provider. Experienced with special needs children.',
    };

    await prisma.users.upsert({
        where: { email: hyderabadNanny.email },
        update: {},
        create: {
            email: hyderabadNanny.email,
            password_hash: 'dummy_hash',
            role: 'nanny',
            is_verified: true,
            profiles: {
                create: {
                    first_name: hyderabadNanny.firstName,
                    last_name: hyderabadNanny.lastName,
                    phone: hyderabadNanny.phone,
                    address: hyderabadNanny.address,
                    lat: hyderabadNanny.lat,
                    lng: hyderabadNanny.lng,
                },
            },
            nanny_details: {
                create: {
                    skills: hyderabadNanny.skills,
                    experience_years: hyderabadNanny.exp,
                    hourly_rate: hyderabadNanny.rate,
                    bio: hyderabadNanny.bio,
                    availability_schedule: {
                        monday: ['08:00-20:00'],
                        tuesday: ['08:00-20:00'],
                        wednesday: ['08:00-20:00'],
                        thursday: ['08:00-20:00'],
                        friday: ['08:00-20:00'],
                        saturday: ['09:00-14:00'],
                    },
                },
            },
        },
    });
    console.log(`Created Hyderabad nanny: ${hyderabadNanny.firstName}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
