import { Test, TestingModule } from "@nestjs/testing";
import { BookingsController } from "./bookings.controller";
import { BookingsService } from "./bookings.service";

describe("BookingsController", () => {
  let controller: BookingsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BookingsController],
      providers: [
        {
          provide: BookingsService,
          useValue: {
            createBooking: jest.fn(),
            getActiveBookings: jest.fn(),
            getBookingsByParent: jest.fn(),
            getBookingsByNanny: jest.fn(),
            getBookingById: jest.fn(),
            startBooking: jest.fn(),
            completeBooking: jest.fn(),
            cancelBooking: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<BookingsController>(BookingsController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
