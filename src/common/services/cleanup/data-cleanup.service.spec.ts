import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DataCleanupService } from "./data-cleanup.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { MailService } from "../../../mail/mail.service";

/**
 * DPDP Rules 2025 sequencing: erasure only ever happens at least 48 hours after
 * the Data Principal was actually informed. The purge is gated on the notice
 * having been sent, and the notice scan has no lower bound so an account that
 * crossed the purge threshold un-notified (mail outage, cron gap) still gets
 * its warning first and is erased two days later — never silently.
 */
describe("DataCleanupService — notice-before-erasure", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function build(prisma: any, mail: any = { sendMail: jest.fn() }) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataCleanupService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    return moduleRef.get(DataCleanupService);
  }

  it("only purges accounts whose pre-erasure notice went out at least 48h ago", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = await build({ users: { findMany } });

    await (svc as any).purgeExpiredAccounts();

    const where = findMany.mock.calls[0][0].where;
    // The retention window must have elapsed…
    expect(where.deleted_at.not).toBeNull();
    expect(where.deleted_at.lte).toBeInstanceOf(Date);
    // …and, critically, the notice must have been sent 48h+ before erasure.
    expect(where.deletion_notice_sent_at.not).toBeNull();
    const noticeCutoff = where.deletion_notice_sent_at.lte as Date;
    expect(Date.now() - noticeCutoff.getTime()).toBeGreaterThanOrEqual(
      DataCleanupService.NOTICE_LEAD_DAYS * DAY - 1000,
    );
  });

  it("still notices an account already past the purge threshold instead of skipping it", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = await build({ users: { findMany } });

    await (svc as any).sendPreErasureNotices();

    const where = findMany.mock.calls[0][0].where;
    // The old query bounded deleted_at with `gt: purgeThreshold`, which excluded
    // exactly the accounts about to be purged un-notified. No lower bound now.
    expect(where.deleted_at.gt).toBeUndefined();
    expect(where.deletion_notice_sent_at).toBeNull();
  });

  it("promises an erasure date at least 48h in the future, even when notified late", async () => {
    // Deleted 40 days ago: the nominal erase-on date is long past.
    const user = {
      id: "u1",
      email: "late@example.com",
      deleted_at: new Date(Date.now() - 40 * DAY),
    };
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const update = jest.fn().mockResolvedValue({});
    const svc = await build(
      { users: { findMany: jest.fn().mockResolvedValue([user]), update } },
      { sendMail },
    );

    await (svc as any).sendPreErasureNotices();

    const eraseDate = new Date(sendMail.mock.calls[0][3].eraseDate);
    // toDateString loses the time, so compare at day granularity.
    expect(eraseDate.getTime()).toBeGreaterThanOrEqual(
      Date.now() + (DataCleanupService.NOTICE_LEAD_DAYS - 1) * DAY,
    );
    // The sent marker is what stops the notice repeating daily.
    expect(update.mock.calls[0][0].data.deletion_notice_sent_at).toBeInstanceOf(Date);
  });

  it("skips already-anonymised accounts in both passes", async () => {
    const ghost = { id: "u2", email: "deleted-u2@keel.dev", deleted_at: new Date() };
    const sendMail = jest.fn();
    const svc = await build(
      { users: { findMany: jest.fn().mockResolvedValue([ghost]), update: jest.fn() } },
      { sendMail },
    );
    const anonymise = jest
      .spyOn(svc, "anonymiseUserData")
      .mockResolvedValue(undefined);

    await (svc as any).sendPreErasureNotices();
    await (svc as any).purgeExpiredAccounts();

    expect(sendMail).not.toHaveBeenCalled();
    expect(anonymise).not.toHaveBeenCalled();
  });
});
