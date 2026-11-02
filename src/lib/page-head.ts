/** Shared company identity with a distinct title and description for each page. */
export function pageHead(page: string, description: string) {
  const title = `${page} — প্রোডাক্ট ডিস্ট্রিবিউশন ম্যানেজমেন্ট | FIROZA ENTERPRISE`;
  return { meta: [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] };
}