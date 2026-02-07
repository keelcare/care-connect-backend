import {
    Injectable,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    NotFoundException,
    SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';

// Metadata key for specifying resource type
export const RESOURCE_TYPE_KEY = 'resourceType';

export enum ResourceType {
    USER = 'user',
    BOOKING = 'booking',
    REQUEST = 'request',
}

/**
 * OwnershipGuard - Ensures users can only access/modify their own resources
 * 
 * Usage:
 * @UseGuards(AuthGuard('jwt'), OwnershipGuard)
 * @ResourceOwnership(ResourceType.USER)
 * @Put(':id')
 * updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) { ... }
 * 
 * This guard:
 * 1. Extracts the resource ID from request params
 * 2. Verifies the authenticated user owns the resource
 * 3. Allows admins to bypass ownership checks
 * 4. Throws ForbiddenException if ownership check fails
 */
@Injectable()
export class OwnershipGuard implements CanActivate {
    constructor(
        private reflector: Reflector,
        private prisma: PrismaService,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const user = request.user; // From JWT auth guard

        if (!user) {
            throw new ForbiddenException('User not authenticated');
        }

        // Admin bypass - admins can access all resources
        if (user.role === 'admin') {
            return true;
        }

        const resourceType = this.reflector.get<ResourceType>(
            RESOURCE_TYPE_KEY,
            context.getHandler(),
        );

        if (!resourceType) {
            // No resource type specified, allow (backward compatibility)
            return true;
        }

        const resourceId = request.params.id;

        if (!resourceId) {
            throw new ForbiddenException('Resource ID is required');
        }

        // Verify ownership based on resource type
        const isOwner = await this.verifyOwnership(
            resourceType,
            resourceId,
            user.id,
        );

        if (!isOwner) {
            throw new ForbiddenException(
                'You do not have permission to access this resource',
            );
        }

        return true;
    }

    /**
     * Verify if the user owns the specified resource
     */
    private async verifyOwnership(
        resourceType: ResourceType,
        resourceId: string,
        userId: string,
    ): Promise<boolean> {
        switch (resourceType) {
            case ResourceType.USER:
                // User can only update their own profile
                return resourceId === userId;

            case ResourceType.BOOKING:
                const booking = await this.prisma.bookings.findUnique({
                    where: { id: resourceId },
                    select: { parent_id: true, nanny_id: true },
                });

                if (!booking) {
                    throw new NotFoundException('Booking not found');
                }

                // User must be either parent or nanny of the booking
                return booking.parent_id === userId || booking.nanny_id === userId;

            case ResourceType.REQUEST:
                const request = await this.prisma.service_requests.findUnique({
                    where: { id: resourceId },
                    select: { parent_id: true },
                });

                if (!request) {
                    throw new NotFoundException('Service request not found');
                }

                // Only the parent who created the request can modify it
                return request.parent_id === userId;

            default:
                return false;
        }
    }
}

/**
 * Decorator to specify resource type for ownership verification
 * 
 * @param resourceType - Type of resource to verify ownership for
 */
export const ResourceOwnership = (resourceType: ResourceType) => SetMetadata(RESOURCE_TYPE_KEY, resourceType);
