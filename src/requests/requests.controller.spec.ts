import { Test, TestingModule } from "@nestjs/testing";
import { RequestsController } from "./requests.controller";
import { RequestsService } from "./requests.service";
import { AuthService } from "../auth/auth.service";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";

describe("RequestsController", () => {
  let controller: RequestsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RequestsController],
      providers: [
        {
          provide: RequestsService,
          useValue: {
            create: jest.fn(),
            findOne: jest.fn(),
            findAllByParent: jest.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<RequestsController>(RequestsController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
