import { Test, TestingModule } from "@nestjs/testing";
import { MailService } from "./mail.service";
import { ConfigService } from "@nestjs/config";

describe("MailService", () => {
  let service: MailService;
  let configService: any;

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === "MAIL_HOST") return "smtp.example.com";
        if (key === "MAIL_PORT") return 587;
        if (key === "MAIL_USER") return "test";
        if (key === "MAIL_PASS") return "pass";
        if (key === "MAIL_FROM") return "noreply@careconnect.com";
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<MailService>(MailService);
  });

  describe("sendMail placeholder substitution", () => {
    it("handles placeholder substitution safely without regex dollar corruption", async () => {
      const sendMailMock = jest.fn().mockResolvedValue({ messageId: "msg-1" });
      (service as any).transporter = { sendMail: sendMailMock, verify: jest.fn() };

      const template = "<p>Your code is: {{code}} and amount: {{amount}}</p>";
      const context = {
        code: "$2a$12$e8uqN...", // bcrypt hash with $ signs
        amount: "$100.00",
      };

      await service.sendMail("user@example.com", "Test Subject", template, context);

      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<p>Your code is: $2a$12$e8uqN... and amount: $100.00</p>",
        }),
      );
    });
  });
});
