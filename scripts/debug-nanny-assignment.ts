import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function debug() {
    console.log('--- REFINED NANNY DEBUG ---');

    // 1. Find the latest request
    const request = await prisma.service_requests.findFirst({
        where: { status: 'pending' },
        orderBy: { created_at: 'desc' },
    });

    if (!request) {
        console.log('No pending requests found.');
        return;
    }

    console.log(`Analyzing for Request ID: ${request.id}`);
    console.log(`Category: ${request.category}`);

    const CATEGORY_SKILL_MAP = {
        'CC': ['Infant Care', 'Toddlers', 'Child Care', 'Babysitting', 'Nanny'],
        'ST': ['Shadow Teacher', 'Special Education', 'Autism Support', 'ADHD Support'],
        'SN': ['Special Needs', 'Disability Care', 'Therapy Support', 'Medical Assistance'],
        'EC': ['Elderly Care', 'Geriatric Support', 'Companion Care'],
    };
    const mappedSkills = CATEGORY_SKILL_MAP[request.category] || [];
    const skillSearchTerms = [request.category, ...mappedSkills].filter(Boolean);
    console.log(`Skill Search Terms: ${JSON.stringify(skillSearchTerms)}`);

    // 2. Find the nannies
    const nannies = await prisma.users.findMany({
        where: { role: 'nanny' },
        orderBy: { created_at: 'desc' },
        take: 3,
        include: {
            profiles: true,
            nanny_details: true,
        },
    });

    for (const n of nannies) {
        console.log(`\nChecking Nanny: ${n.email} (${n.id})`);
        console.log(`- Role: ${n.role}`);
        console.log(`- Verified: ${n.identity_verification_status}`);
        console.log(`- Available Now: ${n.nanny_details?.is_available_now}`);

        // Skill match check
        const nannySkills = n.nanny_details?.skills || [];
        const nannyTags = n.nanny_details?.tags || [];
        const nannyCategories = n.nanny_details?.categories || [];

        const allNannyTerms = [...nannySkills, ...nannyTags, ...nannyCategories];
        const matchingSkills = skillSearchTerms.filter(term => allNannyTerms.includes(term));
        console.log(`- Nanny Skills/Tags/Categories: ${JSON.stringify(allNannyTerms)}`);
        console.log(`- Matching Skills: ${JSON.stringify(matchingSkills)}`);

        // Distance check
        const lat1 = Number(request.location_lat);
        const lng1 = Number(request.location_lng);
        const lat2 = Number(n.profiles?.lat);
        const lng2 = Number(n.profiles?.lng);

        if (lat2 && lng2) {
            const R = 6371;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const distance = R * c;
            console.log(`- Distance: ${distance.toFixed(4)} km`);
        } else {
            console.log(`- Distance: N/A (Missing lat/lng)`);
        }
    }

    await prisma.$disconnect();
}

debug();
