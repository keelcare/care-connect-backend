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

  /**
   * List all children belonging to a parent.
   */
  async findAll(parentId: string) {
    return this.prisma.children.findMany({
      where: { parent_id: parentId },
      orderBy: { created_at: "desc" },
    });
  }

  /**
   * Create a new child profile linked to the parent.
   */
  async create(parentId: string, dto: CreateChildDto) {
    return this.prisma.children.create({
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
        emergency_contact: (dto.emergency_contact as any) ?? undefined,
        school_details: (dto.school_details as any) ?? undefined,
        learning_goals: dto.learning_goals ?? [],
      },
    });
  }

  /**
   * Update an existing child profile.
   * Verifies the child belongs to the requesting parent.
   */
  async update(id: string, parentId: string, dto: UpdateChildDto) {
    const child = await this.prisma.children.findUnique({
      where: { id },
      select: { parent_id: true },
    });

    if (!child) {
      throw new NotFoundException(`Child with ID ${id} not found`);
    }

    if (child.parent_id !== parentId) {
      throw new ForbiddenException(
        "You do not have permission to update this child profile",
      );
    }

    const { dietary_restrictions, ...rest } = dto;
    const data: Record<string, any> = { ...rest };

    // Convert dob string to Date if provided
    if (dto.dob) {
      data.dob = new Date(dto.dob);
    }

    // Map dietary_restrictions array to dietary_notes string
    if (dietary_restrictions !== undefined) {
      data.dietary_notes = dietary_restrictions.length
        ? dietary_restrictions.join(", ")
        : null;
    }

    return this.prisma.children.update({
      where: { id },
      data,
    });
  }

  /**
   * Delete a child profile.
   * Verifies the child belongs to the requesting parent.
   */
  async remove(id: string, parentId: string) {
    const child = await this.prisma.children.findUnique({
      where: { id },
      select: { parent_id: true },
    });

    if (!child) {
      throw new NotFoundException(`Child with ID ${id} not found`);
    }

    if (child.parent_id !== parentId) {
      throw new ForbiddenException(
        "You do not have permission to delete this child profile",
      );
    }

    await this.prisma.children.delete({
      where: { id },
    });

    return { success: true };
  }
}
