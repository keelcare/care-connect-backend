import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateChildDto } from "./dto/create-child.dto";
import { UpdateChildDto } from "./dto/update-child.dto";

@Injectable()
export class FamilyService {
  constructor(private prisma: PrismaService) {}

  private buildMetadata(dto: CreateChildDto | UpdateChildDto): Record<string, any> | undefined {
    const meta: Record<string, any> = {};
    if (dto.personality_notes !== undefined) meta.personality_notes = dto.personality_notes;
    if (dto.hobbies !== undefined)            meta.hobbies           = dto.hobbies;
    if (dto.bedtime !== undefined)            meta.bedtime           = dto.bedtime;
    if (dto.nap_schedule !== undefined)       meta.nap_schedule      = dto.nap_schedule;
    if (dto.allergy_severity !== undefined)   meta.allergy_severity  = dto.allergy_severity;
    if (dto.medical_notes !== undefined)      meta.medical_notes     = dto.medical_notes;
    if (dto.report_url !== undefined)         meta.report_url        = dto.report_url;
    return Object.keys(meta).length ? meta : undefined;
  }

  /** How long a soft-deleted child is recoverable before the cron purges it. */
  static readonly RETENTION_DAYS = 30;

  async findAll(parentId: string) {
    const rows = await this.prisma.children.findMany({
      where: { parent_id: parentId, deleted_at: null },
      orderBy: { created_at: "desc" },
    });
    // Merge metadata into the top-level response so frontend receives flat fields
    return rows.map((c) => this.mergeMetadata(c));
  }

  /**
   * Children the parent removed within the retention window, newest first.
   * Backs the "Recently removed" section so removals can be undone for 30 days.
   */
  async findRecentlyRemoved(parentId: string) {
    const cutoff = new Date(
      Date.now() - FamilyService.RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.children.findMany({
      where: {
        parent_id: parentId,
        deleted_at: { not: null, gte: cutoff },
      },
      orderBy: { deleted_at: "desc" },
    });
    return rows.map((c) => this.mergeMetadata(c));
  }

  private mergeMetadata(child: any) {
    const { metadata, ...rest } = child;
    return { ...rest, ...(metadata ?? {}) };
  }

  async create(parentId: string, dto: CreateChildDto) {
    // Support both emergency_contact and emergency_contact_override
    const emergencyContact = dto.emergency_contact ?? dto.emergency_contact_override;
    const metadata = this.buildMetadata(dto);

    const row = await this.prisma.children.create({
      data: {
        parent_id: parentId,
        first_name: dto.first_name,
        last_name: dto.last_name,
        dob: new Date(dto.dob),
        gender: dto.gender,
        profile_type: dto.profile_type ?? "STANDARD",
        allergies: dto.allergies ?? [],
        dietary_notes: dto.dietary_restrictions?.length
          ? dto.dietary_restrictions.join(", ")
          : null,
        diagnosis: dto.diagnosis ?? null,
        care_instructions: dto.care_instructions ?? null,
        emergency_contact: (emergencyContact as any) ?? undefined,
        school_details: (dto.school_details as any) ?? undefined,
        learning_goals: dto.learning_goals ?? [],
        ...(metadata ? { metadata } : {}),
      },
    });
    return this.mergeMetadata(row);
  }

  async update(id: string, parentId: string, dto: UpdateChildDto) {
    const child = await this.prisma.children.findFirst({
      where: { id, deleted_at: null },
      select: { parent_id: true, metadata: true },
    });

    if (!child) throw new NotFoundException(`Child ${id} not found`);
    if (child.parent_id !== parentId) throw new ForbiddenException("Permission denied");

    const { dietary_restrictions, emergency_contact_override, emergency_contact, ...rest } = dto;

    // Merge incoming metadata patch on top of existing
    const incomingMeta = this.buildMetadata(dto);
    const existingMeta = (child.metadata as Record<string, any>) ?? {};
    const mergedMeta = incomingMeta ? { ...existingMeta, ...incomingMeta } : existingMeta;

    const data: Record<string, any> = { ...rest };

    // Strip metadata-only fields from the top-level data object
    delete data.personality_notes;
    delete data.hobbies;
    delete data.bedtime;
    delete data.nap_schedule;
    delete data.allergy_severity;
    delete data.medical_notes;
    delete data.report_url;

    if (dto.dob) data.dob = new Date(dto.dob);
    if (dietary_restrictions !== undefined) {
      data.dietary_notes = dietary_restrictions.length ? dietary_restrictions.join(", ") : null;
    }
    if (emergency_contact !== undefined || emergency_contact_override !== undefined) {
      data.emergency_contact = (emergency_contact ?? emergency_contact_override) as any;
    }

    data.metadata = Object.keys(mergedMeta).length ? mergedMeta : null;

    const row = await this.prisma.children.update({ where: { id }, data });
    return this.mergeMetadata(row);
  }

  async remove(id: string, parentId: string) {
    const child = await this.prisma.children.findFirst({
      where: { id, deleted_at: null },
      select: { parent_id: true },
    });

    if (!child) throw new NotFoundException(`Child ${id} not found`);
    if (child.parent_id !== parentId) throw new ForbiddenException("Permission denied");

    // Soft delete: hide the child for 30 days (recoverable from "Recently
    // removed"), keeping past bookings intact. The daily cleanup cron
    // hard-deletes rows whose retention window has elapsed.
    await this.prisma.children.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });
    return { success: true };
  }

  async restore(id: string, parentId: string) {
    const cutoff = new Date(
      Date.now() - FamilyService.RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const child = await this.prisma.children.findFirst({
      where: { id, deleted_at: { not: null, gte: cutoff } },
      select: { parent_id: true },
    });

    if (!child) throw new NotFoundException(`Child ${id} not found`);
    if (child.parent_id !== parentId) throw new ForbiddenException("Permission denied");

    const row = await this.prisma.children.update({
      where: { id },
      data: { deleted_at: null, updated_at: new Date() },
    });
    return this.mergeMetadata(row);
  }
}
