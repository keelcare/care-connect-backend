import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import puppeteer, { Browser, PDFOptions } from "puppeteer";

/** A render that hangs must not hold a request open indefinitely. */
const RENDER_TIMEOUT_MS = 20_000;

/**
 * Turns HTML into PDF bytes via headless Chromium.
 *
 * Generic on purpose — it knows nothing about invoices, so progress reports or
 * any other document can use it later.
 *
 * The browser is launched lazily and kept alive between requests: a cold launch
 * is ~1s, which is most of the wait on an otherwise sub-100ms endpoint. Each
 * render still gets its own page, and the page is always closed, because a leaked
 * page is a leaked renderer process.
 */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name);
  private browser: Browser | null = null;
  /** Guards against a burst of first requests launching several browsers. */
  private launching: Promise<Browser> | null = null;

  constructor(private readonly config: ConfigService) {}

  async render(html: string, options: PDFOptions = {}): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);

      // `domcontentloaded` rather than `networkidle0`: the template is fully
      // self-contained (inline CSS, base64 logo, system fonts), so there is no
      // network to wait for and waiting for idle just adds a fixed delay.
      await page.setContent(html, {
        waitUntil: "domcontentloaded",
        timeout: RENDER_TIMEOUT_MS,
      });

      const pdf = await page.pdf({
        format: "A4",
        // The design paints its own navy/ivory blocks; without this they render
        // as white and the document loses every rule and header band.
        printBackground: true,
        // Margins come from the template's own `@page` rule.
        preferCSSPageSize: true,
        timeout: RENDER_TIMEOUT_MS,
        ...options,
      });

      return Buffer.from(pdf);
    } catch (error) {
      this.logger.error(
        `PDF render failed: ${error instanceof Error ? error.message : error}`,
      );
      throw new InternalServerErrorException("Could not generate the PDF");
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.launching) return this.launching;

    this.launching = this.launch();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  private async launch(): Promise<Browser> {
    // Containers run as an unprivileged user with no user namespaces, where
    // Chromium's sandbox cannot start. We only ever render our own templates, so
    // there is no untrusted content for the sandbox to contain.
    const browser = await puppeteer.launch({
      headless: true,
      executablePath:
        this.config.get<string>("PUPPETEER_EXECUTABLE_PATH") || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // /dev/shm is tiny in most containers and Chromium will crash without this.
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    // A crashed or OOM-killed browser must not leave a dead handle behind that
    // every later render then fails against.
    browser.on("disconnected", () => {
      this.browser = null;
    });

    this.logger.log("Headless Chromium launched for PDF rendering");
    return browser;
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
