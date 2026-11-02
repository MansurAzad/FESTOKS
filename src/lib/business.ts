import { useState } from "react";

/** Dealer house identity printed on receipts/invoices (letterhead pad). */
export type Business = { name: string; address: string; phone: string };

const KEY = "business-info";
export const DEFAULT_BUSINESS: Business = { name: "FIROZA ENTERPRISE", address: "KONABARI, GAZIPUR", phone: "01817122232" };

export function getBusiness(): Business {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Business>;
    return { name: saved.name || DEFAULT_BUSINESS.name, address: saved.address || DEFAULT_BUSINESS.address, phone: saved.phone || DEFAULT_BUSINESS.phone };
  } catch {
    return DEFAULT_BUSINESS;
  }
}

export function useBusiness(): [Business, (b: Business) => void] {
  const [b, setB] = useState<Business>(getBusiness);
  const save = (nb: Business) => {
    setB(nb);
    localStorage.setItem(KEY, JSON.stringify(nb));
  };
  return [b, save];
}
