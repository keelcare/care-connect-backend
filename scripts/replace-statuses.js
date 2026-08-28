const fs = require('fs');
const path = require('path');

const filesToUpdate = [
  'src/bookings/bookings.service.ts',
  'src/payments/payments.service.ts',
  'src/admin/admin.service.ts',
  'src/recurring-bookings/recurring-bookings.service.ts',
  'src/availability/availability.service.ts',
  'src/reviews/reviews.service.ts',
];

const enumImport = `import { BookingStatus } from "../common/constants/booking-status.enum";\n`;

for (const file of filesToUpdate) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) continue;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Add import if not present
  if (!content.includes('BookingStatus')) {
    // Find the last import
    const lines = content.split('\n');
    let lastImportIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('import ')) {
        lastImportIndex = i;
      }
    }
    lines.splice(lastImportIndex + 1, 0, enumImport);
    content = lines.join('\n');
  }

  // Replace literal strings with BookingStatus for bookings
  // This is a bit brute force but covers the cases shown in grep.
  content = content.replace(/status:\s*["']CONFIRMED["']/g, 'status: BookingStatus.CONFIRMED');
  content = content.replace(/status:\s*["']IN_PROGRESS["']/g, 'status: BookingStatus.IN_PROGRESS');
  content = content.replace(/status:\s*["']COMPLETED["']/g, 'status: BookingStatus.COMPLETED');
  content = content.replace(/status:\s*["']CANCELLED["']/g, 'status: BookingStatus.CANCELLED');
  content = content.replace(/status:\s*["']requested["']/g, 'status: BookingStatus.REQUESTED');
  content = content.replace(/status:\s*["']EXPIRED["']/g, 'status: BookingStatus.EXPIRED');
  content = content.replace(/status:\s*["']PARENT_NO_SHOW["']/g, 'status: BookingStatus.PARENT_NO_SHOW');
  content = content.replace(/status:\s*["']NANNY_NO_SHOW["']/g, 'status: BookingStatus.NANNY_NO_SHOW');
  
  content = content.replace(/\.status\s*===\s*["']CONFIRMED["']/g, '.status === BookingStatus.CONFIRMED');
  content = content.replace(/\.status\s*!==\s*["']CONFIRMED["']/g, '.status !== BookingStatus.CONFIRMED');
  
  content = content.replace(/\.status\s*===\s*["']IN_PROGRESS["']/g, '.status === BookingStatus.IN_PROGRESS');
  content = content.replace(/\.status\s*!==\s*["']IN_PROGRESS["']/g, '.status !== BookingStatus.IN_PROGRESS');
  
  content = content.replace(/\.status\s*===\s*["']COMPLETED["']/g, '.status === BookingStatus.COMPLETED');
  content = content.replace(/\.status\s*!==\s*["']COMPLETED["']/g, '.status !== BookingStatus.COMPLETED');

  content = content.replace(/\.status\s*===\s*["']CANCELLED["']/g, '.status === BookingStatus.CANCELLED');
  content = content.replace(/\.status\s*!==\s*["']CANCELLED["']/g, '.status !== BookingStatus.CANCELLED');

  content = content.replace(/\.status\s*===\s*["']requested["']/g, '.status === BookingStatus.REQUESTED');
  content = content.replace(/\.status\s*!==\s*["']requested["']/g, '.status !== BookingStatus.REQUESTED');

  content = content.replace(/\.status\s*===\s*["']EXPIRED["']/g, '.status === BookingStatus.EXPIRED');
  content = content.replace(/\.status\s*!==\s*["']EXPIRED["']/g, '.status !== BookingStatus.EXPIRED');

  // specific to array includes: ['CONFIRMED', 'REQUESTED', 'requested'].includes(booking.status)
  content = content.replace(/\['CONFIRMED', 'REQUESTED', 'requested'\]\.includes\(booking\.status\)/g, '[BookingStatus.CONFIRMED, BookingStatus.REQUESTED].includes(booking.status as BookingStatus)');
  
  // ['requested', 'pending', 'accepted', 'CONFIRMED', 'IN_PROGRESS'] in getActiveBookings
  content = content.replace(/in:\s*\["requested", "pending", "accepted", "CONFIRMED", "IN_PROGRESS"\]/g, 'in: [BookingStatus.REQUESTED, "pending", "accepted", BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS]');

  content = content.replace(/in:\s*\["CONFIRMED", "requested"\]/g, 'in: [BookingStatus.CONFIRMED, BookingStatus.REQUESTED]');
  
  fs.writeFileSync(filePath, content);
}
console.log('Done replacing statuses!');
