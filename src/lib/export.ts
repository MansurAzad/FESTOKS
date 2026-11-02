/** CSV (Excel-compatible, BOM so Bengali opens correctly) + download/share helpers. */

type Cell = string | number | null | undefined;

export function toCsv(rows: Cell[][]): string {
  const esc = (v: Cell) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Share via the device share sheet when possible (mobile), else download. */
export async function deliverBlob(blob: Blob, filename: string, title?: string) {
  const file = new File([blob], filename, { type: blob.type });
  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: title ?? filename });
      return;
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
    }
  }
  downloadBlob(blob, filename);
}

export function exportCsv(filename: string, rows: Cell[][], title?: string) {
  return deliverBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), filename, title);
}
