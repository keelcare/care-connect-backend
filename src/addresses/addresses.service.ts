import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAddressDto } from "./dto/create-address.dto";
import { UpdateAddressDto } from "./dto/update-address.dto";

@Injectable()
export class AddressesService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string) {
    return this.prisma.addresses.findMany({
      where: { user_id: userId },
      orderBy: [{ is_default: "desc" }, { updated_at: "desc" }],
    });
  }

  async getDefault(userId: string) {
    return this.prisma.addresses.findFirst({
      where: { user_id: userId, is_default: true },
    });
  }

  /**
   * Resolves the address a booking should happen at: the one the parent picked,
   * else their default. Scoped by user_id so an id from another account 404s
   * rather than silently falling back to the caller's default.
   */
  async resolveForUser(userId: string, addressId?: string) {
    if (!addressId) return this.getDefault(userId);

    const address = await this.prisma.addresses.findFirst({
      where: { id: addressId, user_id: userId },
    });
    if (!address) throw new NotFoundException("Address not found");
    return address;
  }

  async create(userId: string, dto: CreateAddressDto) {
    const existingCount = await this.prisma.addresses.count({
      where: { user_id: userId },
    });
    const makeDefault = dto.isDefault || existingCount === 0;

    return this.prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.addresses.updateMany({
          where: { user_id: userId, is_default: true },
          data: { is_default: false },
        });
      }
      return tx.addresses.create({
        data: {
          user_id: userId,
          label: dto.label ?? "Home",
          address: dto.address,
          lat: dto.lat,
          lng: dto.lng,
          is_default: makeDefault,
        },
      });
    });
  }

  async update(userId: string, id: string, dto: UpdateAddressDto) {
    const existing = await this.prisma.addresses.findFirst({
      where: { id, user_id: userId },
    });
    if (!existing) throw new NotFoundException("Address not found");

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.addresses.updateMany({
          where: { user_id: userId, is_default: true },
          data: { is_default: false },
        });
      }
      return tx.addresses.update({
        where: { id },
        data: {
          label: dto.label,
          address: dto.address,
          lat: dto.lat,
          lng: dto.lng,
          is_default: dto.isDefault ?? undefined,
          updated_at: new Date(),
        },
      });
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.addresses.findFirst({
      where: { id, user_id: userId },
    });
    if (!existing) throw new NotFoundException("Address not found");

    return this.prisma.$transaction(async (tx) => {
      await tx.addresses.delete({ where: { id } });

      if (existing.is_default) {
        const nextDefault = await tx.addresses.findFirst({
          where: { user_id: userId },
          orderBy: { updated_at: "desc" },
        });
        if (nextDefault) {
          await tx.addresses.update({
            where: { id: nextDefault.id },
            data: { is_default: true },
          });
        }
      }
      return { success: true };
    });
  }

  async setDefault(userId: string, id: string) {
    const existing = await this.prisma.addresses.findFirst({
      where: { id, user_id: userId },
    });
    if (!existing) throw new NotFoundException("Address not found");

    return this.prisma.$transaction(async (tx) => {
      await tx.addresses.updateMany({
        where: { user_id: userId, is_default: true },
        data: { is_default: false },
      });
      return tx.addresses.update({
        where: { id },
        data: { is_default: true, updated_at: new Date() },
      });
    });
  }
}
