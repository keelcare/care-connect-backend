import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";
import { UsersService } from "../users/users.service";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { ConsentsService } from "../users/consents.service";

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });

describe("AuthService", () => {
  let service: AuthService;
  let usersService: any;
  let jwtService: any;
  let prisma: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findOneByEmail: jest.fn(),
            findByOAuth: jest.fn(),
            create: jest.fn(),
            findUserForAuth: jest.fn(),
            findOne: jest.fn(),
            findByVerificationToken: jest.fn(),
            findByResetToken: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue("signed-token"),
            verify: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue("secret"),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            users: {
              findUnique: jest.fn(),
              update: jest.fn(),
            },
            services: {
              findMany: jest.fn(),
            },
            revoked_tokens: {
              findUnique: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockResolvedValue({}),
            },
          },
        },
        { provide: MailService, useValue: {} },
        {
          provide: ConsentsService,
          useValue: { storeConsentSafe: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    usersService = module.get(UsersService);
    jwtService = module.get(JwtService);
    prisma = module.get(PrismaService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("exchangeSessionToken", () => {
    const sessionPayload = {
      sub: "user-1",
      type: "session",
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const user = { id: "user-1", email: "a@b.c", role: "parent" };

    it("exchanges a valid session token exactly once", async () => {
      jwtService.verify.mockReturnValue(sessionPayload);
      usersService.findOne.mockResolvedValue(user);
      usersService.update.mockResolvedValue(user);

      const result = await service.exchangeSessionToken("tok");
      expect(result.access_token).toBeDefined();
      expect(prisma.revoked_tokens.create).toHaveBeenCalledWith({
        data: { token: "tok", expires_at: expect.any(Date) },
      });
    });

    it("rejects a replayed session token (duplicate claim)", async () => {
      jwtService.verify.mockReturnValue(sessionPayload);
      prisma.revoked_tokens.create.mockRejectedValue(p2002());

      await expect(service.exchangeSessionToken("tok")).rejects.toThrow(
        UnauthorizedException,
      );
      // The user lookup must never happen once the claim is lost.
      expect(usersService.findOne).not.toHaveBeenCalled();
    });

    it("rejects an access token posing as a session token", async () => {
      // Access tokens share JWT_SECRET and carry `sub`, but not type:"session".
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        email: "a@b.c",
        role: "parent",
        exp: sessionPayload.exp,
      });

      await expect(service.exchangeSessionToken("access")).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.revoked_tokens.create).not.toHaveBeenCalled();
      expect(usersService.findOne).not.toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    let hash: string;
    const payload = {
      sub: "user-1",
      email: "a@b.c",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    beforeEach(async () => {
      hash = await bcrypt.hash("refresh-tok", 4);
      jwtService.verify.mockReturnValue(payload);
      prisma.users.findUnique.mockResolvedValue({
        id: "user-1",
        email: "a@b.c",
        role: "parent",
        refresh_token_hash: hash,
      });
      usersService.update.mockResolvedValue({});
    });

    it("looks the account up by id, not by (mutable) email", async () => {
      await service.refresh("refresh-tok");
      expect(prisma.users.findUnique).toHaveBeenCalledWith({
        where: { id: "user-1" },
      });
    });

    it("rejects when the rotation claim is lost to a concurrent refresh", async () => {
      prisma.revoked_tokens.create.mockRejectedValue(p2002());
      await expect(service.refresh("refresh-tok")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("does not log the user out on a non-duplicate bookkeeping error", async () => {
      prisma.revoked_tokens.create.mockRejectedValue(new Error("db blip"));
      const result = await service.refresh("refresh-tok");
      expect(result.access_token).toBeDefined();
    });

    it("rejects a token already recorded as revoked", async () => {
      prisma.revoked_tokens.findUnique.mockResolvedValue({ id: "r1" });
      await expect(service.refresh("refresh-tok")).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe("verifyEmail", () => {
    it("rejects a missing token instead of querying unfiltered", async () => {
      await expect(service.verifyEmail(undefined as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(usersService.findByVerificationToken).not.toHaveBeenCalled();
    });

    it("rejects an array token (?token=a&token=b)", async () => {
      await expect(service.verifyEmail(["a", "b"] as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(usersService.findByVerificationToken).not.toHaveBeenCalled();
    });

    it("verifies with a valid, unexpired token", async () => {
      usersService.findByVerificationToken.mockResolvedValue({
        id: "user-1",
        verification_token_expires: new Date(Date.now() + 60000),
      });
      usersService.update.mockResolvedValue({});
      const result = await service.verifyEmail("good-token");
      expect(result.message).toBe("Email verified successfully");
      expect(usersService.update).toHaveBeenCalledWith("user-1", {
        is_verified: true,
        verification_token: null,
        verification_token_expires: null,
      });
    });
  });

  describe("login", () => {
    it("refuses accounts in the deletion window", async () => {
      await expect(
        service.login({ id: "u1", deleted_at: new Date() }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
