import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { TokenBlacklistService } from "./token-blacklist.service";

describe("AuthController", () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            validateUser: jest.fn(),
            login: jest.fn(),
            register: jest.fn(),
            googleLogin: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            decode: jest.fn(),
          },
        },
        {
          provide: TokenBlacklistService,
          useValue: {
            revokeToken: jest.fn(),
            isRevoked: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("logout", () => {
    let authService: any;
    let jwtService: any;
    let blacklist: any;
    const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };

    beforeEach(() => {
      authService = controller["authService"];
      authService.clearRefreshToken = jest.fn();
      jwtService = controller["jwtService"];
      jwtService.verify = jest.fn();
      blacklist = controller["tokenBlacklist"];
      const config = controller["configService"] as any;
      config.get = jest.fn((key: string) =>
        key === "JWT_SECRET" || key === "JWT_REFRESH_SECRET" ? "s" : undefined,
      );
    });

    it("ignores a forged token: no revoke, no refresh-hash clearing", async () => {
      jwtService.verify.mockImplementation(() => {
        throw new UnauthorizedException("bad signature");
      });
      const req = { cookies: { access_token: "forged" } };

      const result = await controller.logout(req, res);

      expect(result.success).toBe(true);
      expect(blacklist.revokeToken).not.toHaveBeenCalled();
      expect(authService.clearRefreshToken).not.toHaveBeenCalled();
    });

    it("revokes verified tokens and clears the stored refresh hash", async () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      jwtService.verify.mockReturnValue({ sub: "user-1", exp });
      const req = {
        cookies: { access_token: "real-access", refresh_token: "real-refresh" },
      };

      await controller.logout(req, res);

      expect(blacklist.revokeToken).toHaveBeenCalledTimes(2);
      expect(authService.clearRefreshToken).toHaveBeenCalledWith("user-1");
    });

    it("still identifies the caller from an expired-but-genuine token", async () => {
      // verify() is called with ignoreExpiration, so a genuine expired token
      // yields its payload; exp in the past means nothing left to blacklist.
      const exp = Math.floor(Date.now() / 1000) - 60;
      jwtService.verify.mockReturnValue({ sub: "user-1", exp });
      const req = { cookies: { access_token: "expired-access" } };

      await controller.logout(req, res);

      expect(blacklist.revokeToken).not.toHaveBeenCalled();
      expect(authService.clearRefreshToken).toHaveBeenCalledWith("user-1");
    });
  });
});
