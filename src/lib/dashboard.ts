import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type OverdueRetailer = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  salesman_name: string | null;
  total_due: number;
  overdue_amount: number;
  age_days: number;
};
export type LowStockProduct = {
  id: string;
  name: string;
  model: string | null;
  qty: number;
  low_stock_threshold: number;
};
export type DashboardInsights = {
  overdue: OverdueRetailer[];
  overdueTotal: number;
  lowStock: LowStockProduct[];
  warehouseQty: number | null;
  warehouseValue: number | null;
  warehouseUnknownCostQty: number | null;
  todaySales: number;
  monthSales: number;
  salesTotal: number;
  invoiceCount: number;
  collected: number;
  cashInHand: number;
  deposited: number;
  retailerDue: number;
  heldQty: number;
  heldValue: number;
  heldUnknownCostQty: number;
  knownGrossProfit: number;
  unknownCostSoldQty: number;
  returnedQty: number;
  damagedQty: number;
  retailerCount: number;
  activeSalesmen: number;
};

export function isLowStock(quantity: number, threshold: number) {
  return threshold > 0 && quantity < threshold;
}

export function useDashboardInsights() {
  return useQuery({
    queryKey: ["dashboard-insights"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("distribution_insights");
      if (error) throw error;
      return data as unknown as DashboardInsights;
    },
  });
}
