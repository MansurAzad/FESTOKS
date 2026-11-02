import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight, Phone, FileDown } from "lucide-react";
import { PrintSheet, TableDoc } from "@/components/PrintDocs";
import { getBusiness } from "@/lib/business";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { isLowStock, type DashboardInsights } from "@/lib/dashboard";
import { Button } from "@/components/ui/button";

export function DashboardAlerts({ data, isAdmin }: { data: DashboardInsights; isAdmin: boolean }) {
  const { t } = useT();
  const [printing, setPrinting] = useState(false);
  const lowStock = data.lowStock.filter((p) => isLowStock(p.qty, p.low_stock_threshold));
  return (
    <div className="space-y-5">
      {printing && <PrintSheet onDone={() => setPrinting(false)}><TableDoc b={getBusiness()} appName={t("appName")} title={t("overdueRetailers")} head={[t("retailers"), t("phone"), t("address"), ...(isAdmin ? [t("salesmen")] : []), t("days"), t("overdueBalance"), t("totalDue")]} rows={[...data.overdue.map((r) => [r.name, r.phone ?? "", r.address ?? "", ...(isAdmin ? [r.salesman_name ?? ""] : []), r.age_days, money(r.overdue_amount), money(r.total_due)]), [t("total"), "", "", ...(isAdmin ? [""] : []), "", money(data.overdueTotal), money(data.overdue.reduce((sum, r) => sum + r.total_due, 0))]]} /></PrintSheet>}
      <section className="border-y border-destructive/30 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="flex items-start gap-2 text-lg font-bold text-destructive"><AlertTriangle className="mt-1 h-5 w-5 shrink-0" />{t("overdueRetailers")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("overdueBalance")}: <strong className="text-destructive">{money(data.overdueTotal)}</strong> · {data.overdue.length} {t("retailers")}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setPrinting(true)}><FileDown className="h-4 w-4" />{t("pdfExport")}</Button>
            <Button asChild size="sm" variant="outline"><Link to="/retailers">{t("ledger")}<ArrowUpRight className="h-4 w-4" /></Link></Button>
          </div>
        </div>
        {data.overdue.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{t("noOverdue")}</p> : (
          <div className="mt-3 divide-y">
            {data.overdue.map((r) => (
              <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <div className="min-w-0">
                  <Link to="/retailers" className="break-words font-semibold hover:underline">{r.name}</Link>
                  {r.address && <div className="break-words text-xs text-muted-foreground">{r.address}</div>}
                  {isAdmin && r.salesman_name && <div className="text-xs text-muted-foreground">{t("salesmen")}: {r.salesman_name}</div>}
                  {r.phone && <a className="mt-1 inline-flex items-center gap-1 text-xs text-primary" href={`tel:${r.phone}`}><Phone className="h-3 w-3" />{r.phone}</a>}
                </div>
                <div className="text-right"><div className="text-xs text-muted-foreground">{t("overdueBalance")}</div><div className="font-bold text-destructive">{money(r.overdue_amount)}</div><div className="text-xs">{r.age_days} {t("days")}</div></div>
                <div className="col-span-full text-xs text-muted-foreground sm:col-span-1 sm:text-right">{t("totalDue")}: <span className="font-semibold">{money(r.total_due)}</span></div>
              </div>
            ))}
          </div>
        )}
      </section>
      {isAdmin && lowStock.length > 0 && (
        <section role="alert" className="border-y border-destructive/40 bg-destructive/5 px-3 py-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <h2 className="flex items-start gap-2 text-lg font-bold text-destructive"><AlertTriangle className="mt-1 h-5 w-5 shrink-0" />{t("lowStockAlert")} ({lowStock.length})</h2>
            <Button asChild size="sm" variant="outline"><Link to="/products">{t("stock")}<ArrowUpRight className="h-4 w-4" /></Link></Button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {lowStock.map((p) => (
              <div key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-l-2 border-destructive py-2 pl-3">
                <div className="min-w-0 break-words"><div className="font-semibold">{p.name} {p.model}</div><div className="text-xs text-muted-foreground">{t("stockThreshold")}: {p.low_stock_threshold}</div></div>
                <div className="text-right text-destructive"><div className="text-xs">{t("stock")}</div><div className="text-xl font-bold">{p.qty}</div></div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}