const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
console.log(Object.keys(prisma));
console.log('revoked_tokens exists:', 'revoked_tokens' in prisma); 
