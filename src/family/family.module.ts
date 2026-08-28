import { Module } from "@nestjs/common";
import { FamilyService } from "./family.service";
import { FamilyController } from "./family.controller";
// Adding a child is the point at which DPDPA s.9 verifiable parental consent is
// captured, so the family module needs the consent recorder.
import { UsersModule } from "../users/users.module";

@Module({
  imports: [UsersModule],
  controllers: [FamilyController],
  providers: [FamilyService],
  exports: [FamilyService],
})
export class FamilyModule {}
