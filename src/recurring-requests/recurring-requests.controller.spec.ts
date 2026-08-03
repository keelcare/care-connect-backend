import { Test, TestingModule } from '@nestjs/testing';
import { RecurringRequestsController } from './recurring-requests.controller';
import { RecurringRequestsService } from './recurring-requests.service';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

describe('RecurringRequestsController', () => {
  let controller: RecurringRequestsController;

  const mockService = {
    create: jest.fn(),
    findAllByParent: jest.fn(),
    findOne: jest.fn(),
    cancel: jest.fn(),
    getPlanBookings: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RecurringRequestsController],
      providers: [
        { provide: RecurringRequestsService, useValue: mockService },
        // The controller's auth guard is constructed by Nest even in a unit test.
        { provide: AuthService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    controller = module.get<RecurringRequestsController>(RecurringRequestsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('scopes the parent listing to the caller, never to a client-supplied id', async () => {
    mockService.findAllByParent.mockResolvedValue([]);

    await controller.findAllMyRequests({ user: { id: 'parent-1' } } as any);

    expect(mockService.findAllByParent).toHaveBeenCalledWith('parent-1');
  });
});
