import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAddressDto } from "./dto/create-address.dto";
import { UpdateAddressDto } from "./dto/update-address.dto";
import type { addresses } from "@prisma/client";

/**
 * Prisma Decimal serialises to a JSON *string* ("12.97160000"), but API
 * consumers (the mobile Address type) declare lat/lng as numbers. Coerce at
 * the boundary so no client ever does arithmetic on a string.
 */
type ApiAddress = Omit<addresses, "lat" | "lng"> & { lat: number; lng: number };

function toApi(record: addresses): ApiAddress;
function toApi(record: addresses | null): ApiAddress | null;
function toApi(record: addresses | null): ApiAddress | null {
  if (!record) return null;
  return {
    ...record,
    lat: Number(record.lat),
    lng: Number(record.lng),
  };
}

@Injectable()
export class AddressesService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string) {
    const rows = await this.prisma.addresses.findMany({
      where: { user_id: userId, deleted_at: null },
      orderBy: [{ is_default: "desc" }, { updated_at: "desc" }],
    });
    return rows.map(toApi);
  }

  async getDefault(userId: string) {
    const row = await this.prisma.addresses.findFirst({
      where: { user_id: userId, is_default: true, deleted_at: null },
    });
    return toApi(row);
  }

  /**
   * Resolves the address a booking should happen at: the one the parent picked,
   * else their default. Scoped by user_id so an id from another account 404s
   * rather than silently falling back to the caller's default.
   */
  async resolveForUser(userId: string, addressId?: string) {
    if (!addressId) return this.getDefault(userId);

    const address = await this.prisma.addresses.findFirst({
      where: { id: addressId, user_id: userId, deleted_at: null },
    });
    if (!address) throw new NotFoundException("Address not found");
    return toApi(address);
  }

  async create(userId: string, dto: CreateAddressDto) {
    const existingCount = await this.prisma.addresses.count({
      where: { user_id: userId, deleted_at: null },
    });
    const makeDefault = dto.isDefault || existingCount === 0;

    return this.prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.addresses.updateMany({
          where: { user_id: userId, is_default: true },
          data: { is_default: false },
        });
      }
      const created = await tx.addresses.create({
        data: {
          user_id: userId,
          label: dto.label ?? "Home",
          address: dto.address,
          lat: dto.lat,
          lng: dto.lng,
          is_default: makeDefault,
        },
      });
      return toApi(created);
    });
  }

  async update(userId: string, id: string, dto: UpdateAddressDto) {
    const existing = await this.prisma.addresses.findFirst({
      where: { id, user_id: userId, deleted_at: null },
    });
    if (!existing) throw new NotFoundException("Address not found");

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.addresses.updateMany({
          where: { user_id: userId, is_default: true },
          data: { is_default: false },
        });
      }
      const updated = await tx.addresses.update({
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
      return toApi(updated);
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.addresses.findFirst({
      where: { id, user_id: userId, deleted_at: null },
    });
    if (!existing) throw new NotFoundException("Address not found");

    // Soft delete: bookings that happened at this address keep their history,
    // and the row remains as an audit trail. All reads filter deleted_at.
    return this.prisma.$transaction(async (tx) => {
      await tx.addresses.update({
        where: { id },
        data: { deleted_at: new Date(), is_default: false, updated_at: new Date() },
      });

      if (existing.is_default) {
        const nextDefault = await tx.addresses.findFirst({
          where: { user_id: userId, deleted_at: null },
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
      where: { id, user_id: userId, deleted_at: null },
    });
    if (!existing) throw new NotFoundException("Address not found");

    return this.prisma.$transaction(async (tx) => {
      await tx.addresses.updateMany({
        where: { user_id: userId, is_default: true },
        data: { is_default: false },
      });
      const updated = await tx.addresses.update({
        where: { id },
        data: { is_default: true, updated_at: new Date() },
      });
      return toApi(updated);
    });
  }
}
