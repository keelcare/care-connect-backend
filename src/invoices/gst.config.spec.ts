import { Test, TestingModule } from "@nestjs/testing";
import { GstConfigService, GST_REGISTRATION_KEY } from "./gst.config";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Keel collects 18% GST but has never issued a tax invoice. These pin down the
 * switchover: what "registered" actually requires, and how the tax splits once
 * it is — the two things a return is reconciled against.
 */
describe("GstConfigService", () => {
  let service: GstConfigService;

  const mockPrisma = { system_settings: { findUnique: jest.fn() } };

  const setting = (value: Record<string, unknown> | null) =>
    mockPrisma.system_settings.findUnique.mockResolvedValue(
      value === null ? null : { key: GST_REGISTRATION_KEY, value },
    );

  const REGISTERED = {
    enabled: true,
    gstin: "27AAAAA0000A1Z5",
    legal_name: "Keel Learning Private Limited",
    supplier_state_code: "27",
    place_of_supply_state_code: "27",
    place_of_supply_name: "Maharashtra",
    default_sac_code: "999599",
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GstConfigService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(GstConfigService);
  });

  describe("getRegistration", () => {
    it("is unregistered when the setting has never been written", async () => {
      setting(null);
      expect((await service.getRegistration()).enabled).toBe(false);
    });

    it("refuses to be registered without a GSTIN", async () => {
      // A document titled "Tax Invoice" over a blank GSTIN claims a status it
      // cannot evidence — worse than either state on its own.
      setting({ enabled: true, gstin: "" });

      const registration = await service.getRegistration();

      expect(registration.enabled).toBe(false);
      expect(registration.gstin).toBe("");
    });

    it("takes the supplier state from the GSTIN when none is given", async () => {
      setting({ enabled: true, gstin: "29AAAAA0000A1Z5" });

      const registration = await service.getRegistration();

      expect(registration.supplierStateCode).toBe("29");
      // Absent a stated place of supply, it is the supplier's own state — which
      // makes the default intra-state, never a surprise IGST bill.
      expect(registration.placeOfSupplyStateCode).toBe("29");
    });

    it("normalises a lower-case GSTIN", async () => {
      setting({ enabled: true, gstin: "27aaaaa0000a1z5" });
      expect((await service.getRegistration()).gstin).toBe("27AAAAA0000A1Z5");
    });
  });

  describe("taxLines", () => {
    it("shows one plain GST line while unregistered", async () => {
      setting(null);
      const registration = await service.getRegistration();

      expect(service.taxLines(registration, 18, 1800)).toEqual([
        { label: "GST (18%)", amount: 1800 },
      ]);
    });

    it("splits an intra-state supply into CGST and SGST at half the rate", async () => {
      setting(REGISTERED);
      const registration = await service.getRegistration();

      expect(service.taxLines(registration, 18, 1800)).toEqual([
        { label: "CGST (9%)", amount: 900 },
        { label: "SGST (9%)", amount: 900 },
      ]);
    });

    it("bills an inter-state supply as a single IGST line", async () => {
      setting({ ...REGISTERED, place_of_supply_state_code: "29" });
      const registration = await service.getRegistration();

      expect(service.taxLines(registration, 18, 1800)).toEqual([
        { label: "IGST (18%)", amount: 1800 },
      ]);
    });

    it("keeps the two halves summing to the tax actually charged", async () => {
      // The reason this splits paise off the total rather than halving the rate:
      // 9% of an odd amount, computed twice, lands a paisa either side of what
      // was collected — and a return reconciles to the paisa.
      setting(REGISTERED);
      const registration = await service.getRegistration();

      const lines = service.taxLines(registration, 18, 900.01);
      const total = lines.reduce((sum, line) => sum + line.amount, 0);

      expect(Math.round(total * 100)).toBe(90001);
      expect(lines[0].amount).toBe(450);
      expect(lines[1].amount).toBe(450.01);
    });

    it("trims a rate's trailing zeros rather than printing false precision", async () => {
      setting(REGISTERED);
      const registration = await service.getRegistration();

      expect(service.taxLines(registration, 5, 100)[0].label).toBe("CGST (2.5%)");
    });
  });
});
