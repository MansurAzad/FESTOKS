import { useEffect, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import type { Business } from "@/lib/business";
// Logo is served from /public so printed letterheads work on every host.
const LOGO_URL = "/firoza-logo.png";

/** Mounts a printable sheet into <body> and opens the print dialog (Save as PDF). */
export function PrintSheet({ children, onDone }: { children: ReactNode; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => window.print(), 120);
    const done = () => onDone();
    window.addEventListener("afterprint", done);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", done);
    };
  }, [onDone]);
  return createPortal(<div className="print-sheet">{children}</div>, document.body);
}

const cell: CSSProperties = { border: "1px solid #94a3b8", padding: "4px 8px", fontSize: 12 };
const th: CSSProperties = { ...cell, background: "#0f766e", color: "#fff", textAlign: "left", fontWeight: 700 };
const thR: CSSProperties = { ...th, textAlign: "right" };
const tdR: CSSProperties = { ...cell, textAlign: "right" };

const fmtDate = (iso: string) => new Date(iso).toLocaleString("bn-BD", { dateStyle: "medium", timeStyle: "short" });

function Letterhead({ b, title, fallbackName }: { b: Business; title: string; fallbackName: string }) {
  return (
    <div style={{ textAlign: "center", borderBottom: "3px double #0f766e", paddingBottom: 10, marginBottom: 12 }}>
      <img src={LOGO_URL} alt={b.name || fallbackName} style={{ height: 64, margin: "0 auto 6px", display: "block" }} />
      <div style={{ fontSize: 24, fontWeight: 800, color: "#0f766e" }}>{b.name || fallbackName}</div>
      {(b.address || b.phone) && (
        <div style={{ fontSize: 12, color: "#334155" }}>{[b.address, b.phone].filter(Boolean).join(" · ")}</div>
      )}
      <div style={{ marginTop: 8 }}>
        <span style={{ display: "inline-block", border: "1.5px solid #0f766e", borderRadius: 6, padding: "2px 16px", fontSize: 14, fontWeight: 700 }}>
          {title}
        </span>
      </div>
    </div>
  );
}

function Signatures({ left, right }: { left: string; right: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 56, fontSize: 12 }}>
      <div style={{ borderTop: "1px solid #0f172a", paddingTop: 4, width: 170, textAlign: "center" }}>{left}</div>
      <div style={{ borderTop: "1px solid #0f172a", paddingTop: 4, width: 170, textAlign: "center" }}>{right}</div>
    </div>
  );
}

export type ReceiptItem = { name: string; qty: number; unit_price: number; imeis: string[] };

/** Business-standard sales invoice / receipt for a retailer sale. */
export function SaleReceiptDoc({
  b, appName, saleId, date, retailerName, retailerMeta, items, total, paid,
}: {
  b: Business; appName: string; saleId: string; date: string;
  retailerName: string; retailerMeta?: string | undefined; items: ReceiptItem[]; total: number; paid: number;
}) {
  const { t } = useT();
  return (
    <div>
      <Letterhead b={b} title={t("saleInvoice")} fallbackName={appName} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 8 }}>
        <div><b>{t("retailers")}:</b> {retailerName}{retailerMeta ? ` · ${retailerMeta}` : ""}</div>
        <div style={{ textAlign: "right" }}>
          <div>{t("receipt")} #: {saleId.slice(0, 8).toUpperCase()}</div>
          <div>{t("date")}: {fmtDate(date)}</div>
        </div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th style={th}>#</th><th style={th}>{t("products")}</th><th style={thR}>{t("qty")}</th><th style={thR}>{t("price")}</th><th style={thR}>{t("total")}</th></tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td style={cell}>{i + 1}</td>
              <td style={cell}>
                {it.name}
                {it.imeis.length > 0 && <div style={{ fontSize: 10, color: "#475569" }}>IMEI: {it.imeis.join(", ")}</div>}
              </td>
              <td style={tdR}>{it.qty}</td>
              <td style={tdR}>{money(it.unit_price)}</td>
              <td style={tdR}>{money(it.qty * it.unit_price)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={4} style={{ ...tdR, fontWeight: 700 }}>{t("total")}</td><td style={{ ...tdR, fontWeight: 700 }}>{money(total)}</td></tr>
          <tr><td colSpan={4} style={tdR}>{t("paid")}</td><td style={tdR}>{money(paid)}</td></tr>
          <tr><td colSpan={4} style={{ ...tdR, fontWeight: 700 }}>{t("due")}</td><td style={{ ...tdR, fontWeight: 700 }}>{money(total - paid)}</td></tr>
        </tfoot>
      </table>
      <Signatures left={t("salesmen")} right={t("retailers")} />
    </div>
  );
}

/** Money receipt for a payment collected from a retailer. */
export function MoneyReceiptDoc({
  b, appName, receiptId, date, fromName, fromMeta, amount, note, receivedBy,
}: {
  b: Business; appName: string; receiptId: string; date: string;
  fromName: string; fromMeta?: string | undefined; amount: number; note?: string | null | undefined; receivedBy: string;
}) {
  const { t } = useT();
  return (
    <div>
      <Letterhead b={b} title={t("moneyReceipt")} fallbackName={appName} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 12 }}>
        <div>{t("receipt")} #: {receiptId.slice(0, 8).toUpperCase()}</div>
        <div>{t("date")}: {fmtDate(date)}</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr><td style={{ ...cell, width: "40%", fontWeight: 700 }}>{t("receivedFrom")}</td><td style={cell}>{fromName}{fromMeta ? ` · ${fromMeta}` : ""}</td></tr>
          <tr><td style={{ ...cell, fontWeight: 700 }}>{t("amount")}</td><td style={{ ...cell, fontSize: 16, fontWeight: 800 }}>{money(amount)}</td></tr>
          {note && <tr><td style={{ ...cell, fontWeight: 700 }}>Note</td><td style={cell}>{note}</td></tr>}
        </tbody>
      </table>
      <Signatures left={receivedBy} right={fromName} />
    </div>
  );
}

/** Retailer ledger: all sales & payments with running totals. */
export function LedgerDoc({
  b, appName, retailerName, retailerMeta, entries, total, paid,
}: {
  b: Business; appName: string; retailerName: string; retailerMeta?: string | undefined;
  entries: { date: string; label: string; debit: number; credit: number }[];
  total: number; paid: number;
}) {
  const { t } = useT();
  return (
    <div>
      <Letterhead b={b} title={`${t("ledger")} — ${retailerName}`} fallbackName={appName} />
      {retailerMeta && <div style={{ fontSize: 12, marginBottom: 8 }}>{retailerMeta}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th style={th}>{t("date")}</th><th style={th}>{t("items")}</th><th style={thR}>{t("sales")}</th><th style={thR}>{t("paid")}</th></tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i}>
              <td style={cell}>{new Date(e.date).toLocaleDateString("bn-BD")}</td>
              <td style={cell}>{e.label}</td>
              <td style={tdR}>{e.debit ? money(e.debit) : ""}</td>
              <td style={tdR}>{e.credit ? money(e.credit) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={2} style={{ ...tdR, fontWeight: 700 }}>{t("total")}</td><td style={{ ...tdR, fontWeight: 700 }}>{money(total)}</td><td style={{ ...tdR, fontWeight: 700 }}>{money(paid)}</td></tr>
          <tr><td colSpan={3} style={{ ...tdR, fontWeight: 700 }}>{t("due")}</td><td style={{ ...tdR, fontWeight: 700 }}>{money(total - paid)}</td></tr>
        </tfoot>
      </table>
      <Signatures left={t("salesmen")} right={t("retailers")} />
    </div>
  );
}

/** Generic printable table report (stock lists, summaries). */
export function TableDoc({
  b, appName, title, head, rows,
}: {
  b: Business; appName: string; title: string; head: string[]; rows: (string | number)[][];
}) {
  const { t } = useT();
  return (
    <div>
      <Letterhead b={b} title={title} fallbackName={appName} />
      <div style={{ fontSize: 12, marginBottom: 8, textAlign: "right" }}>{t("date")}: {new Date().toLocaleDateString("bn-BD", { dateStyle: "medium" })}</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} style={i === 0 ? th : thR}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} style={j === 0 ? cell : tdR}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type SettlementProduct = { name: string; issued: number; sold: number; returned: number; damaged: number; hand: number; value: number };

/** Trip settlement report: goods movement + money account for one salesman. */
export function SettlementDoc({
  b, appName, salesmanName, products, salesTotal, cashInHand, deposited, retailerDue, owesDealer,
}: {
  b: Business; appName: string; salesmanName: string; products: SettlementProduct[];
  salesTotal: number; cashInHand: number; deposited: number; retailerDue: number; owesDealer: number;
}) {
  const { t } = useT();
  return (
    <div>
      <Letterhead b={b} title={t("settlementReport")} fallbackName={appName} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 8 }}>
        <div><b>{t("salesmen")}:</b> {salesmanName}</div>
        <div>{t("date")}: {new Date().toLocaleDateString("bn-BD", { dateStyle: "medium" })}</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead>
          <tr><th style={th}>{t("products")}</th><th style={thR}>{t("issued")}</th><th style={thR}>{t("sold")}</th><th style={thR}>{t("returned")}</th><th style={thR}>{t("damaged")}</th><th style={thR}>{t("inHand")}</th><th style={thR}>{t("goodsValue")}</th></tr>
        </thead>
        <tbody>
          {products.map((p, i) => (
            <tr key={i}>
              <td style={cell}>{p.name}</td><td style={tdR}>{p.issued}</td><td style={tdR}>{p.sold}</td>
              <td style={tdR}>{p.returned}</td><td style={tdR}>{p.damaged}</td><td style={{ ...tdR, fontWeight: 700 }}>{p.hand}</td>
              <td style={tdR}>{money(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr><td style={{ ...cell, fontWeight: 700 }}>{t("sales")}</td><td style={tdR}>{money(salesTotal)}</td></tr>
          <tr><td style={{ ...cell, fontWeight: 700 }}>{t("retailerDue")}</td><td style={tdR}>{money(retailerDue)}</td></tr>
          <tr><td style={{ ...cell, fontWeight: 700 }}>{t("cashInHand")}</td><td style={tdR}>{money(cashInHand)}</td></tr>
          <tr><td style={{ ...cell, fontWeight: 700 }}>{t("deposited")}</td><td style={tdR}>{money(deposited)}</td></tr>
          <tr><td style={{ ...cell, fontWeight: 700 }}>{t("owesDealer")}</td><td style={{ ...tdR, fontWeight: 800 }}>{money(owesDealer)}</td></tr>
        </tbody>
      </table>
      <Signatures left={t("salesmen")} right={t("businessOwner")} />
    </div>
  );
}
