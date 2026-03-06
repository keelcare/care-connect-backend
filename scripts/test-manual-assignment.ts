import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AdminService } from '../src/admin/admin.service';

async function test() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const adminService = app.get(AdminService);

    const requestId = '4c49443f-2a8e-42cd-85a0-fe4e5662fe7b';
    const nannyId = '0a2a3e32-6aa1-4ffc-b55e-b7d9269a78a8';

    console.log(`Testing Manual Assignment: Request ${requestId} to Nanny ${nannyId}`);

    try {
        const result = await adminService.manuallyAssignNanny(requestId, nannyId);
        console.log('SUCCESS:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('FAILED with error:');
        console.error(error);
        if (error.response) console.error('Response:', JSON.stringify(error.response, null, 2));
    } finally {
        await app.close();
    }
}

test();
