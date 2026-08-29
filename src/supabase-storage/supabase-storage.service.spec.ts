import { Test, TestingModule } from "@nestjs/testing";
import { SupabaseStorageService } from "./supabase-storage.service";
import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";

describe("SupabaseStorageService", () => {
  let service: SupabaseStorageService;
  let configService: any;

  describe("when not configured", () => {
    beforeEach(async () => {
      configService = {
        get: jest.fn(() => null),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SupabaseStorageService,
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();

      service = module.get<SupabaseStorageService>(SupabaseStorageService);
    });

    it("does not crash on initialization and throws ServiceUnavailableException on operations", async () => {
      const mockFile: any = {
        originalname: "doc.pdf",
        buffer: Buffer.from("content"),
        mimetype: "application/pdf",
      };

      await expect(service.uploadFile("user-1", mockFile)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
