import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) { }

  // Category Request Management
  async getCategoryRequests(status: string = 'pending') {
    return this.prisma.nanny_category_requests.findMany({
      where: { status },
      include: {
        users: {
          select: {
            email: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateCategoryRequestStatus(requestId: string, status: 'approved' | 'rejected', adminNotes?: string) {
    return this.prisma.$transaction(async (prisma) => {
      const existingRequest = await prisma.nanny_category_requests.findUnique({
        where: { id: requestId },
      });

      if (!existingRequest) {
        throw new NotFoundException('Category request not found');
      }

      if (existingRequest.status !== 'pending') {
        throw new BadRequestException(`Request is already ${existingRequest.status}`);
      }

      const request = await prisma.nanny_category_requests.update({
        where: { id: requestId },
        data: {
          status,
          admin_notes: adminNotes,
          updated_at: new Date(),
        },
      });

      if (status === 'approved') {
        // Use upsert to handle cases where nanny_details record doesn't exist yet
        await prisma.nanny_details.upsert({
          where: { user_id: request.nanny_id },
          update: {
            categories: request.requested_categories,
            tags: request.requested_categories, // Sync to tags for backward compatibility
            updated_at: new Date(),
          },
          create: {
            user_id: request.nanny_id,
            categories: request.requested_categories,
            tags: request.requested_categories, // Sync to tags for backward compatibility
          },
        });
      }

      return request;
    });
  }

  // User Management
  async getAllUsers() {
    return this.prisma.users.findMany({
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        is_verified: true,
        is_active: true,
        ban_reason: true,
        created_at: true,
        profiles: {
          select: {
            first_name: true,
            last_name: true,
          },
        },
      },
    });
  }

  async verifyUser(userId: string) {
    return this.prisma.users.update({
      where: { id: userId },
      data: { is_verified: true },
    });
  }

  async banUser(userId: string, reason?: string) {
    return this.prisma.users.update({
      where: { id: userId },
      data: {
        is_active: false,
        ban_reason: reason,
      },
    });
  }

  async unbanUser(userId: string) {
    return this.prisma.users.update({
      where: { id: userId },
      data: {
        is_active: true,
        ban_reason: null,
      },
    });
  }

  // Booking Management
  async getAllBookings() {
    return this.prisma.bookings.findMany({
      orderBy: { created_at: "desc" },
      include: {
        jobs: true,
        service_requests: true,
        users_bookings_parent_idTousers: {
          select: {
            email: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
        users_bookings_nanny_idTousers: {
          select: {
            email: true,
            profiles: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
    });
  }

  // Dispute Resolution
  async getAllDisputes() {
    return this.prisma.disputes.findMany({
      orderBy: { created_at: "desc" },
      include: {
        bookings: {
          include: {
            users_bookings_parent_idTousers: {
              select: {
                email: true,
                profiles: { select: { first_name: true, last_name: true } },
              },
            },
            users_bookings_nanny_idTousers: {
              select: {
                email: true,
                profiles: { select: { first_name: true, last_name: true } },
              },
            },
          },
        },
        users_disputes_raised_byTousers: {
          select: {
            email: true,
            profiles: { select: { first_name: true, last_name: true } },
          },
        },
        users_disputes_resolved_byTousers: {
          select: {
            email: true,
            profiles: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });
  }

  async getDisputeById(id: string) {
    return this.prisma.disputes.findUnique({
      where: { id },
      include: {
        bookings: true,
        users_disputes_raised_byTousers: {
          select: { email: true, profiles: true },
        },
      },
    });
  }

  async resolveDispute(id: string, resolution: string, resolvedBy: string) {
    return this.prisma.disputes.update({
      where: { id },
      data: {
        status: "resolved",
        resolution,
        resolved_by: resolvedBy,
        updated_at: new Date(),
      },
    });
  }

  // Payment Monitoring
  async getAllPayments() {
    return this.prisma.payments.findMany({
      orderBy: { created_at: "desc" },
      include: {
        bookings: {
          include: {
            users_bookings_parent_idTousers: {
              select: {
                email: true,
                profiles: { select: { first_name: true, last_name: true } },
              },
            },
            users_bookings_nanny_idTousers: {
              select: {
                email: true,
                profiles: { select: { first_name: true, last_name: true } },
              },
            },
          },
        },
      },
    });
  }

  async getPaymentStats() {
    const totalPayments = await this.prisma.payments.count();
    const totalAmount = await this.prisma.payments.aggregate({
      _sum: { amount: true },
    });
    const pendingPayments = await this.prisma.payments.count({
      where: { status: "pending_release" },
    });

    return {
      totalPayments,
      totalAmount: totalAmount._sum.amount || 0,
      pendingPayments,
    };
  }

  // Review Moderation
  async getAllReviews() {
    return this.prisma.reviews.findMany({
      orderBy: { created_at: "desc" },
      include: {
        users_reviews_reviewer_idTousers: {
          select: {
            email: true,
            profiles: { select: { first_name: true, last_name: true } },
          },
        },
        users_reviews_reviewee_idTousers: {
          select: {
            email: true,
            profiles: { select: { first_name: true, last_name: true } },
          },
        },
        bookings: true,
      },
    });
  }

  async approveReview(id: string) {
    return this.prisma.reviews.update({
      where: { id },
      data: {
        is_approved: true,
        moderation_status: "approved",
      },
    });
  }

  async rejectReview(id: string) {
    return this.prisma.reviews.update({
      where: { id },
      data: {
        is_approved: false,
        moderation_status: "rejected",
      },
    });
  }

  // Matching Configuration
  async getSettings() {
    return this.prisma.system_settings.findMany();
  }

  async getSetting(key: string) {
    return this.prisma.system_settings.findUnique({
      where: { key },
    });
  }

  async updateSetting(key: string, value: any) {
    return this.prisma.system_settings.upsert({
      where: { key },
      update: { value, updated_at: new Date() },
      create: { key, value },
    });
  }

  // Analytics
  async getSystemStats() {
    const totalUsers = await this.prisma.users.count();
    const totalBookings = await this.prisma.bookings.count();
    const activeBookings = await this.prisma.bookings.count({
      where: { status: "IN_PROGRESS" },
    });

    return {
      totalUsers,
      totalBookings,
      activeBookings,
    };
  }

  async getAdvancedStats() {
    const totalRequests = await this.prisma.service_requests.count();
    const completedBookings = await this.prisma.bookings.count({
      where: { status: "COMPLETED" },
    });
    const cancelledBookings = await this.prisma.bookings.count({
      where: { status: "CANCELLED" },
    });

    const completionRate =
      totalRequests > 0 ? (completedBookings / totalRequests) * 100 : 0;

    const totalAssignments = await this.prisma.assignments.count();
    const acceptedAssignments = await this.prisma.assignments.count({
      where: { status: "accepted" },
    });
    const acceptanceRate =
      totalAssignments > 0 ? (acceptedAssignments / totalAssignments) * 100 : 0;

    const revenueData = await this.prisma.payments.aggregate({
      _sum: { amount: true },
    });
    const totalRevenue = revenueData._sum.amount || 0;

    // Popular service times (simplified - count by hour of day)
    const bookings = await this.prisma.bookings.findMany({
      where: { start_time: { not: null } },
      select: { start_time: true },
    });

    const hourCounts = new Array(24).fill(0);
    bookings.forEach((booking) => {
      if (booking.start_time) {
        const hour = new Date(booking.start_time).getHours();
        hourCounts[hour]++;
      }
    });

    const popularTimes = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      completionRate: Math.round(completionRate * 10) / 10,
      acceptanceRate: Math.round(acceptanceRate * 10) / 10,
      totalRevenue,
      popularTimes,
      totalRequests,
      completedBookings,
      cancelledBookings,
    };
  }
}
