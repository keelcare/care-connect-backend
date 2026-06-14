import { Test, TestingModule } from '@nestjs/testing';
import { RecurringRequestsController } from './recurring-requests.controller';

describe('RecurringRequestsController', () => {
  let controller: RecurringRequestsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RecurringRequestsController],
    }).compile();

    controller = module.get<RecurringRequestsController>(RecurringRequestsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
