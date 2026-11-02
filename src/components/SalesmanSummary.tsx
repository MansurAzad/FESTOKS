import { useSalesmanSummary } from "@/lib/me";
import { useT } from "@/lib/i18n";
import { money } from "@/lib/imei";
import { Stat } from "./Stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function SalesmanSummary({ salesmanId }: { salesmanId: string }) {
  const { t } = useT();
  const { data } = useSalesmanSummary(salesmanId);
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label={t("sales")} value={money(data.salesTotal)} />
        <Stat label={t("cashInHand")} value={money(data.cashInHand)} tone="accent" />
        <Stat label={t("deposited")} value={money(data.deposited)} tone="good" />
        <Stat label={t("retailerDue")} value={money(data.retailerDue)} tone="bad" />
        <Stat
          label={t("goodsValue")}
          value={money(data.products.reduce((a, p) => a + p.value, 0))}
        />
        <Stat
          label={t("unknownHeldCost")}
          value={String(data.products.reduce((a, p) => a + p.unknownCostHand, 0))}
        />
        <Stat
          label={t("knownGrossProfit")}
          value={money(data.products.reduce((a, p) => a + p.knownGrossProfit, 0))}
          tone="good"
        />
        <Stat label={t("unknownCostSold")} value={String(data.unknownCostSoldQty)} />
        <Stat label={t("owesDealer")} value={money(data.owesDealer)} />
      </div>
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("products")}</TableHead>
              <TableHead>{t("issued")}</TableHead>
              <TableHead>{t("sold")}</TableHead>
              <TableHead>{t("returned")}</TableHead>
              <TableHead>{t("damaged")}</TableHead>
              <TableHead>{t("inHand")}</TableHead>
              <TableHead>{t("goodsValue")}</TableHead>
              <TableHead>{t("unknownHeldCost")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.products.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  {t("noData")}
                </TableCell>
              </TableRow>
            )}
            {data.products.map((p) => (
              <TableRow key={p.product_id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{p.issued}</TableCell>
                <TableCell>{p.sold}</TableCell>
                <TableCell>{p.returned}</TableCell>
                <TableCell>{p.damaged}</TableCell>
                <TableCell className="font-bold">{p.hand}</TableCell>
                <TableCell>{money(p.value)}</TableCell>
                <TableCell>{p.unknownCostHand}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
