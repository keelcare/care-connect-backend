import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCategoryRequestDto } from "./dto/create-category-request.dto";

@Injectable()
export class NanniesService {
  constructor(private prisma: PrismaService) {}

  async createCategoryRequest(userId: string, dto: CreateCategoryRequestDto) {
    // Validate categories exist
    const validServices = await this.prisma.services.findMany({
      where: {
        name: { in: dto.categories },
      },
    });

    if (validServices.length !== dto.categories.length) {
      const validNames = validServices.map((s) => s.name);
      const invalidNames = dto.categories.filter(
        (c) => !validNames.includes(c),
      );
      throw new BadRequestException(
        `Invalid categories: ${invalidNames.join(", ")}`,
      );
    }

    // Check if there is already a pending request
    const existingRequest = await this.prisma.nanny_category_requests.findFirst(
      {
        where: {
          nanny_id: userId,
          status: "pending",
        },
      },
    );

    if (existingRequest) {
      throw new BadRequestException(
        "You already have a pending category change request",
      );
    }

    try {
      return await this.prisma.nanny_category_requests.create({
        data: {
          nanny_id: userId,
          requested_categories: dto.categories,
          status: "pending",
        },
      });
    } catch (error) {
      if (error.code === "P2002") {
        throw new BadRequestException(
          "You already have a pending category change request",
        );
      }
      throw error;
    }
  }

  async cancelCategoryRequest(userId: string, requestId: string) {
    // Validate it's a UUID to prevent Prisma 500 errors
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(requestId)) {
      throw new BadRequestException("Invalid request ID format");
    }

    const request = await this.prisma.nanny_category_requests.findFirst({
      where: {
        id: requestId,
        nanny_id: userId,
      },
    });

    if (!request) {
      throw new NotFoundException("Category request not found");
    }

    if (request.status !== "pending") {
      throw new BadRequestException(
        `Cannot cancel a request that is already ${request.status}`,
      );
    }

    return this.prisma.nanny_category_requests.delete({
      where: { id: requestId },
    });
  }

  async getMyCategoryRequest(userId: string) {
    return this.prisma.nanny_category_requests.findFirst({
      where: {
        nanny_id: userId,
        status: "pending",
      },
      orderBy: {
        created_at: "desc",
      },
    });
  }

  async getMyCategoryRequestsHistory(userId: string) {
    return this.prisma.nanny_category_requests.findMany({
      where: {
        nanny_id: userId,
      },
      orderBy: {
        created_at: "desc",
      },
    });
  }
}
