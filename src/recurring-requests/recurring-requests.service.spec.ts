import { Test, TestingModule } from '@nestjs/testing';
import { RecurringRequestsService } from './recurring-requests.service';

describe('RecurringRequestsService', () => {
  let service: RecurringRequestsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RecurringRequestsService],
    }).compile();

    service = module.get<RecurringRequestsService>(RecurringRequestsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
