import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Key in `system_settings` holding the platform's GST registration.
 *
 * Lives in the database rather than env because registration is a finance event,
 * not a deploy: the certificate arrives, an admin types the GSTIN in, and the
 * next document issued is a tax invoice. Nothing restarts.
 */
export const GST_REGISTRATION_KEY = "gst_registration";

/** Statutory rate, mirroring `PricingEngineService`'s own default. */
const DEFAULT_GST_PERCENT = 18;

/** Services, other than those specified elsewhere. A sane starting SAC. */
const DEFAULT_SAC_CODE = "999599";

export interface GstRegistration {
  /**
   * Whether documents issued *from now on* are tax invoices.
   *
   * Never read at render time — it is copied into each document's snapshot when
   * the document is issued. Flipping this must not turn last quarter's receipts
   * into tax invoices retrospectively.
   */
  enabled: boolean;
  gstin: string;
  legalName: string;
  tradeName: string;
  /** Two-digit state code of the place of supply, e.g. `27` for Maharashtra. */
  placeOfSupplyStateCode: string;
  placeOfSupplyName: string;
  /** Two-digit state code the supplier is registered in. */
  supplierStateCode: string;
  defaultSacCode: string;
}

/** One tax row on a document: `CGST (9%)`, `IGST (18%)`, or plain `GST (18%)`. */
export interface GstTaxLine {
  label: string;
  amount: number;
}

const UNREGISTERED: GstRegistration = {
  enabled: false,
  gstin: "",
  legalName: "",
  tradeName: "",
  placeOfSupplyStateCode: "",
  placeOfSupplyName: "",
  supplierStateCode: "",
  defaultSacCode: DEFAULT_SAC_CODE,
};

/**
 * The platform's GST registration, and the tax arithmetic that depends on it.
 *
 * Kept apart from `PricingEngineService`, which owns whether GST is *charged* and
 * at what rate. This owns whether the resulting document is a *tax invoice* —
 * GSTIN, SAC, place of supply, and the CGST/SGST versus IGST split. The two are
 * genuinely independent: Keel has been collecting 18% for months on documents
 * that were never tax invoices, which is exactly the gap this closes.
 */
@Injectable()
export class GstConfigService {
  private readonly logger = new Logger(GstConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getRegistration(): Promise<GstRegistration> {
    const row = await this.prisma.system_settings.findUnique({
      where: { key: GST_REGISTRATION_KEY },
    });
    if (!row) return UNREGISTERED;

    const value = (row.value ?? {}) as Record<string, unknown>;
    const gstin = this.str(value.gstin).toUpperCase();
    const enabled = value.enabled === true || value.enabled === "true";

    // Registration without a GSTIN is not registration. Honouring the flag alone
    // would print "Tax Invoice" over a blank number, which is worse than either
    // state on its own — a document that claims a status it cannot evidence.
    if (enabled && !gstin) {
      this.logger.warn(
        `${GST_REGISTRATION_KEY} is enabled but has no GSTIN; issuing documents as unregistered.`,
      );
      return UNREGISTERED;
    }

    const supplierStateCode =
      this.str(value.supplier_state_code) || gstin.slice(0, 2);

    return {
      enabled,
      gstin,
      legalName: this.str(value.legal_name),
      tradeName: this.str(value.trade_name),
      placeOfSupplyStateCode:
        this.str(value.place_of_supply_state_code) || supplierStateCode,
      placeOfSupplyName: this.str(value.place_of_supply_name),
      supplierStateCode,
      defaultSacCode: this.str(value.default_sac_code) || DEFAULT_SAC_CODE,
    };
  }

  /**
   * True when supplier state and place of supply differ, so the tax is IGST
   * rather than CGST + SGST.
   */
  isInterState(registration: GstRegistration): boolean {
    return (
      !!registration.placeOfSupplyStateCode &&
      !!registration.supplierStateCode &&
      registration.placeOfSupplyStateCode !== registration.supplierStateCode
    );
  }

  /**
   * How one rate's worth of tax should be presented.
   *
   * Intra-state supply splits into CGST and SGST at half the rate each;
   * inter-state is a single IGST line at the full rate. Split in paise off the
   * total rather than halving the rate and re-multiplying, so an odd amount
   * cannot leave the two halves summing to a paisa either side of the tax
   * actually charged.
   */
  taxLines(
    registration: GstRegistration,
    percent: number,
    amount: number,
  ): GstTaxLine[] {
    const rate = Number.isFinite(percent) && percent > 0 ? percent : 0;
    const total = Math.round((Number.isFinite(amount) ? amount : 0) * 100);

    if (!registration.enabled) {
      return [{ label: `GST (${trim(rate)}%)`, amount: total / 100 }];
    }

    if (this.isInterState(registration)) {
      return [{ label: `IGST (${trim(rate)}%)`, amount: total / 100 }];
    }

    const half = Math.floor(total / 2);
    return [
      { label: `CGST (${trim(rate / 2)}%)`, amount: half / 100 },
      // The remainder rides on SGST, so CGST + SGST is exactly the tax charged.
      { label: `SGST (${trim(rate / 2)}%)`, amount: (total - half) / 100 },
    ];
  }

  /** The rate to assume when a snapshot predates frozen GST columns. */
  get defaultPercent(): number {
    return DEFAULT_GST_PERCENT;
  }

  private str(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }
}

/** `9` → `"9"`, `9.00` → `"9"`, `2.50` → `"2.5"` — trailing zeros read as false precision. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)));
}
