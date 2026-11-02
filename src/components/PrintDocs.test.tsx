import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LangProvider } from "@/lib/i18n";
import { DEFAULT_BUSINESS } from "@/lib/business";
import { SaleReceiptDoc } from "./PrintDocs";
const LOGO_URL = "/firoza-logo.png";

describe("print letterhead logo", () => {
  it("renders the company logo image on printed documents", () => {
    const html = renderToStaticMarkup(
      <LangProvider>
        <SaleReceiptDoc
          b={DEFAULT_BUSINESS}
          appName="PDM"
          saleId="abc123"
          date="2026-11-01T00:00:00Z"
          retailerName="Test"
          items={[{ name: "Phone", qty: 1, unit_price: 100, imeis: [] }]}
          total={100}
          paid={100}
        />
      </LangProvider>,
    );
    expect(html).toContain(`src="${LOGO_URL}"`);
  });
});
