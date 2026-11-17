const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// '2026-03-15' -> 'Mar 2026'
export function monthLabel(isoDate) {
  const [year, month] = isoDate.split("-").map(Number);
  return `${MONTHS[month - 2] ?? "Dec"} ${year}`;
}
